export const schemaV1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS clients (
 id uuid PRIMARY KEY, name text NOT NULL, phone text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trips (
 id uuid PRIMARY KEY, origin text NOT NULL, destination text NOT NULL,
 departure_at timestamptz NOT NULL, capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 60),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 status text NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bookings (
 id uuid PRIMARY KEY, trip_id uuid NOT NULL REFERENCES trips(id), client_id uuid NOT NULL REFERENCES clients(id),
 seats integer NOT NULL CHECK(seats BETWEEN 1 AND 60), total_minor integer NOT NULL CHECK(total_minor >= 0),
 status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled')),
 note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_trip_idx ON bookings(trip_id);
CREATE TABLE IF NOT EXISTS payments (
 id uuid PRIMARY KEY, booking_id uuid NOT NULL REFERENCES bookings(id),
 amount_minor integer NOT NULL CHECK(amount_minor > 0),
 method text NOT NULL CHECK(method IN ('cash','transfer','card')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_booking_idx ON payments(booking_id);
CREATE TABLE IF NOT EXISTS audit_events (
 id uuid PRIMARY KEY, entity_id uuid NOT NULL, action text NOT NULL, details jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
`;

// Version 1 remains unchanged. Apply version 2 atomically to existing databases.
export const migrationV2 = `
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=2) THEN
 CREATE TABLE drivers (
  id uuid PRIMARY KEY, name text NOT NULL, phone text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('staff','partner')),
  status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','unavailable')),
  license_number text NOT NULL, license_expires date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE vehicles (
  id uuid PRIMARY KEY, plate text NOT NULL UNIQUE, model text NOT NULL,
  capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 60), owner_name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('park','partner')),
  status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','maintenance','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE users (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE, name text NOT NULL,
  password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('owner','dispatcher','driver')),
  driver_id uuid UNIQUE REFERENCES drivers(id), active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((role='driver' AND driver_id IS NOT NULL) OR (role<>'driver' AND driver_id IS NULL))
 );
 CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX sessions_user_idx ON sessions(user_id);
 CREATE TABLE login_attempts (username text PRIMARY KEY, failures integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now());
 ALTER TABLE trips ADD COLUMN ends_at timestamptz;
 UPDATE trips SET ends_at=departure_at + interval '6 hours';
 ALTER TABLE trips ALTER COLUMN ends_at SET NOT NULL;
 ALTER TABLE trips ADD CONSTRAINT trip_time_order CHECK(ends_at>departure_at);
 ALTER TABLE trips ADD COLUMN driver_id uuid REFERENCES drivers(id);
 ALTER TABLE trips ADD COLUMN vehicle_id uuid REFERENCES vehicles(id);
 ALTER TABLE trips ADD CONSTRAINT trip_assignment_pair CHECK((driver_id IS NULL)=(vehicle_id IS NULL));
 CREATE INDEX trips_driver_time_idx ON trips(driver_id, departure_at, ends_at);
 CREATE INDEX trips_vehicle_time_idx ON trips(vehicle_id, departure_at, ends_at);
 ALTER TABLE audit_events ADD COLUMN actor_id uuid REFERENCES users(id);
 INSERT INTO schema_migrations(version) VALUES(2);
END IF;
END $$;
`;
export const migrationV3 = `
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=3) THEN
 ALTER TABLE trips ADD COLUMN completed_at timestamptz;
 CREATE TABLE mutation_receipts (
  request_id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL, payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE refunds (
  id uuid PRIMARY KEY, booking_id uuid NOT NULL REFERENCES bookings(id),
  amount_minor integer NOT NULL CHECK(amount_minor>0), method text NOT NULL CHECK(method IN ('cash','transfer','card')),
  reason text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX refunds_booking_idx ON refunds(booking_id);
 CREATE TABLE trip_expenses (
  id uuid PRIMARY KEY, trip_id uuid NOT NULL REFERENCES trips(id),
  amount_minor integer NOT NULL CHECK(amount_minor>0),
  category text NOT NULL CHECK(category IN ('fuel','toll','parking','other')),
  paid_by text NOT NULL CHECK(paid_by IN ('park','driver')), description text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz, void_reason text
 );
 CREATE INDEX trip_expenses_trip_idx ON trip_expenses(trip_id);
 CREATE TABLE driver_settlements (
  trip_id uuid PRIMARY KEY REFERENCES trips(id), driver_id uuid NOT NULL REFERENCES drivers(id),
  fee_minor integer NOT NULL CHECK(fee_minor>=0), reimbursement_minor bigint NOT NULL CHECK(reimbursement_minor>=0),
  note text NOT NULL, approved_by uuid NOT NULL REFERENCES users(id), approved_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE driver_payouts (
  id uuid PRIMARY KEY, trip_id uuid NOT NULL REFERENCES driver_settlements(trip_id),
  amount_minor integer NOT NULL CHECK(amount_minor>0), method text NOT NULL CHECK(method IN ('cash','transfer','card')),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX driver_payouts_trip_idx ON driver_payouts(trip_id);
 INSERT INTO schema_migrations(version) VALUES(3);
END IF;
END $$;
`;
export const migrationV4 = `
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=4) THEN
 ALTER TABLE bookings ADD COLUMN booking_type text NOT NULL DEFAULT 'seats' CHECK(booking_type IN ('seats','vehicle'));
 ALTER TABLE bookings ADD COLUMN passenger_count integer NOT NULL DEFAULT 1 CHECK(passenger_count BETWEEN 1 AND 60);
 ALTER TABLE bookings ADD COLUMN passengers jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(passengers)='array');
 ALTER TABLE bookings ADD COLUMN contact_name text NOT NULL DEFAULT '';
 ALTER TABLE bookings ADD COLUMN contact_phone text NOT NULL DEFAULT '';
 ALTER TABLE bookings ADD COLUMN pickup_address text NOT NULL DEFAULT '';
 ALTER TABLE bookings ADD COLUMN dropoff_address text NOT NULL DEFAULT '';
 ALTER TABLE bookings ADD COLUMN luggage text NOT NULL DEFAULT '';
 ALTER TABLE bookings ADD COLUMN child_seats integer NOT NULL DEFAULT 0 CHECK(child_seats BETWEEN 0 AND 60);
 ALTER TABLE bookings ADD COLUMN source text NOT NULL DEFAULT 'other' CHECK(source IN ('phone','whatsapp','telegram','website','aggregator','other'));
 UPDATE bookings b SET passenger_count=b.seats,contact_name=c.name,contact_phone=c.phone,
 passengers=jsonb_build_array(jsonb_build_object('name',c.name,'phone',c.phone)) FROM clients c WHERE c.id=b.client_id;
 INSERT INTO schema_migrations(version) VALUES(4);
END IF;
END $$;
`;
export const migrationV5 = `
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=5) THEN
 ALTER TABLE trips DROP CONSTRAINT trips_status_check;
 ALTER TABLE trips ADD CONSTRAINT trips_status_check CHECK(status IN ('scheduled','completed','cancelled'));
 ALTER TABLE trips ADD COLUMN cancelled_at timestamptz;
 ALTER TABLE trips ADD COLUMN cancel_reason text;
 CREATE TABLE passenger_attendance (
  booking_id uuid NOT NULL REFERENCES bookings(id), position integer NOT NULL CHECK(position BETWEEN 0 AND 59),
  status text NOT NULL CHECK(status IN ('boarded','no_show')),
  changed_by uuid NOT NULL REFERENCES users(id), changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(booking_id,position)
 );
 INSERT INTO schema_migrations(version) VALUES(5);
END IF;
END $$;
`;
export const migrationV6 = `
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=6) THEN
 ALTER TABLE trips ADD COLUMN create_request_id uuid UNIQUE;
 ALTER TABLE bookings ADD COLUMN create_request_id uuid UNIQUE;
 INSERT INTO schema_migrations(version) VALUES(6);
END IF;
END $$;
`;
export const migrationV7 = `
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=7) THEN
 CREATE TABLE client_notes(id uuid PRIMARY KEY,client_id uuid NOT NULL REFERENCES clients(id),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),author_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX client_notes_client_idx ON client_notes(client_id);
 CREATE TABLE work_tasks(id uuid PRIMARY KEY,title text NOT NULL CHECK(length(title) BETWEEN 3 AND 200),description text NOT NULL DEFAULT '',status text NOT NULL CHECK(status IN ('open','in_progress','done','cancelled')),assignee_id uuid NOT NULL REFERENCES users(id),client_id uuid REFERENCES clients(id),trip_id uuid REFERENCES trips(id),due_at timestamptz NOT NULL,version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX work_tasks_due_idx ON work_tasks(status,due_at);
 INSERT INTO schema_migrations(version) VALUES(7);
END IF;
END $$;
`;
export const migrationV8 = `
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=8) THEN
 CREATE TABLE park_settings(id uuid PRIMARY KEY CHECK(id='00000000-0000-4000-8000-000000000008'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),default_currency text NOT NULL CHECK(default_currency IN ('KGS','KZT','RUB','USD')),version integer NOT NULL DEFAULT 1);
 INSERT INTO park_settings(id,name,default_currency) VALUES('00000000-0000-4000-8000-000000000008','KARVEN','KGS');
 CREATE TABLE route_templates(id uuid PRIMARY KEY,origin text NOT NULL,destination text NOT NULL,currency text NOT NULL CHECK(currency IN ('KGS','KZT','RUB','USD')),capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 60),duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 15 AND 10080),seat_minor integer CHECK(seat_minor BETWEEN 0 AND 999999999),vehicle_minor integer CHECK(vehicle_minor BETWEEN 0 AND 999999999),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,CHECK(lower(origin)<>lower(destination)));
 CREATE UNIQUE INDEX route_templates_direction_currency_idx ON route_templates(lower(origin),lower(destination),currency);
 INSERT INTO schema_migrations(version) VALUES(8);
END IF;
END $$;
`;
export const migrationV9 = `
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=9) THEN
 CREATE TABLE telegram_settings(id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,encrypted_token text,chat_id text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1,last_test_at timestamptz,last_test_error text);
 INSERT INTO telegram_settings(id) VALUES(1);
 CREATE TABLE telegram_outbox(booking_id uuid PRIMARY KEY REFERENCES bookings(id),settings_version integer NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),attempts integer NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now(),next_attempt_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz);
 CREATE INDEX telegram_outbox_pending_idx ON telegram_outbox(status,next_attempt_at);
 INSERT INTO schema_migrations(version) VALUES(9);
END IF;
END $$;
`;
export const schema = schemaV1 + migrationV2 + migrationV3 + migrationV4 + migrationV5 + migrationV6 + migrationV7 + migrationV8 + migrationV9;
