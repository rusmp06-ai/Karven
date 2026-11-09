-- KARVEN: выполнить целиком как один запрос. RLS включается внутри блока.
DO $karven_install$
BEGIN
 PERFORM pg_advisory_xact_lock(746376002::bigint);
 EXECUTE 'CREATE SCHEMA IF NOT EXISTS karven';
 EXECUTE 'REVOKE ALL ON SCHEMA karven FROM PUBLIC';
 PERFORM set_config('search_path','karven,pg_catalog',true);
 EXECUTE $karven_schema$

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

DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=6) THEN
 ALTER TABLE trips ADD COLUMN create_request_id uuid UNIQUE;
 ALTER TABLE bookings ADD COLUMN create_request_id uuid UNIQUE;
 INSERT INTO schema_migrations(version) VALUES(6);
END IF;
END $$;

DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=7) THEN
 CREATE TABLE client_notes(id uuid PRIMARY KEY,client_id uuid NOT NULL REFERENCES clients(id),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),author_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX client_notes_client_idx ON client_notes(client_id);
 CREATE TABLE work_tasks(id uuid PRIMARY KEY,title text NOT NULL CHECK(length(title) BETWEEN 3 AND 200),description text NOT NULL DEFAULT '',status text NOT NULL CHECK(status IN ('open','in_progress','done','cancelled')),assignee_id uuid NOT NULL REFERENCES users(id),client_id uuid REFERENCES clients(id),trip_id uuid REFERENCES trips(id),due_at timestamptz NOT NULL,version integer NOT NULL DEFAULT 1,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX work_tasks_due_idx ON work_tasks(status,due_at);
 INSERT INTO schema_migrations(version) VALUES(7);
END IF;
END $$;

DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=8) THEN
 CREATE TABLE park_settings(id uuid PRIMARY KEY CHECK(id='00000000-0000-4000-8000-000000000008'),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),default_currency text NOT NULL CHECK(default_currency IN ('KGS','KZT','RUB','USD')),version integer NOT NULL DEFAULT 1);
 INSERT INTO park_settings(id,name,default_currency) VALUES('00000000-0000-4000-8000-000000000008','KARVEN','KGS');
 CREATE TABLE route_templates(id uuid PRIMARY KEY,origin text NOT NULL,destination text NOT NULL,currency text NOT NULL CHECK(currency IN ('KGS','KZT','RUB','USD')),capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 60),duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 15 AND 10080),seat_minor integer CHECK(seat_minor BETWEEN 0 AND 999999999),vehicle_minor integer CHECK(vehicle_minor BETWEEN 0 AND 999999999),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,CHECK(lower(origin)<>lower(destination)));
 CREATE UNIQUE INDEX route_templates_direction_currency_idx ON route_templates(lower(origin),lower(destination),currency);
 INSERT INTO schema_migrations(version) VALUES(8);
END IF;
END $$;

DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=9) THEN
 CREATE TABLE telegram_settings(id integer PRIMARY KEY CHECK(id=1),enabled boolean NOT NULL DEFAULT false,encrypted_token text,chat_id text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1,last_test_at timestamptz,last_test_error text);
 INSERT INTO telegram_settings(id) VALUES(1);
 CREATE TABLE telegram_outbox(booking_id uuid PRIMARY KEY REFERENCES bookings(id),settings_version integer NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),attempts integer NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now(),next_attempt_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz);
 CREATE INDEX telegram_outbox_pending_idx ON telegram_outbox(status,next_attempt_at);
 INSERT INTO schema_migrations(version) VALUES(9);
END IF;
END $$;

DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=10) THEN
 ALTER TABLE bookings ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
 CREATE TABLE booking_cancellations(
  booking_id uuid PRIMARY KEY REFERENCES bookings(id),initiator text NOT NULL CHECK(initiator IN ('client','park','legacy')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),retention_reason text NOT NULL DEFAULT '',
  paid_at_cancel_minor integer NOT NULL CHECK(paid_at_cancel_minor>=0),retained_minor integer NOT NULL CHECK(retained_minor>=0),return_due_minor integer NOT NULL CHECK(return_due_minor>=0),
  created_by uuid REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),legacy boolean NOT NULL DEFAULT false,
  CHECK(retained_minor+return_due_minor=paid_at_cancel_minor),CHECK(initiator<>'park' OR retained_minor=0),CHECK(retained_minor=0 OR length(retention_reason)>=3)
 );
 INSERT INTO booking_cancellations(booking_id,initiator,reason,paid_at_cancel_minor,retained_minor,return_due_minor,created_by,created_at,legacy)
 SELECT b.id,'legacy',COALESCE(NULLIF(h.details->>'reason',''),'Историческая отмена: причина не сохранена'),0,0,0,h.actor_id,COALESCE(h.created_at,b.created_at),true
 FROM bookings b LEFT JOIN LATERAL(SELECT details,actor_id,created_at FROM audit_events WHERE entity_id=b.id AND action='booking.cancelled' ORDER BY created_at DESC LIMIT 1) h ON true WHERE b.status='cancelled';
 CREATE TABLE work_shifts(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),opened_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,close_note text NOT NULL DEFAULT '');
 CREATE UNIQUE INDEX work_shifts_one_open ON work_shifts(user_id) WHERE closed_at IS NULL;
 CREATE TABLE shift_balances(shift_id uuid NOT NULL REFERENCES work_shifts(id),currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),opening_minor bigint NOT NULL DEFAULT 0,expected_minor bigint,declared_minor bigint,CHECK(declared_minor IS NULL OR declared_minor>=0),PRIMARY KEY(shift_id,currency));
 CREATE TABLE cash_transfers(id uuid PRIMARY KEY,from_shift_id uuid NOT NULL REFERENCES work_shifts(id),to_shift_id uuid NOT NULL REFERENCES work_shifts(id),currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),amount_minor integer NOT NULL CHECK(amount_minor>0),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),reason text NOT NULL CHECK(length(reason)>=3),created_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,decided_by uuid REFERENCES users(id),CHECK(from_shift_id<>to_shift_id));
 ALTER TABLE payments ADD COLUMN created_by uuid REFERENCES users(id);
 ALTER TABLE payments ADD COLUMN shift_id uuid REFERENCES work_shifts(id);
 ALTER TABLE refunds ADD COLUMN shift_id uuid REFERENCES work_shifts(id);
 ALTER TABLE refunds ADD COLUMN cancellation_booking_id uuid REFERENCES booking_cancellations(booking_id);
 ALTER TABLE trip_expenses ADD COLUMN shift_id uuid REFERENCES work_shifts(id);
 ALTER TABLE trip_expenses ADD COLUMN method text NOT NULL DEFAULT 'unknown' CHECK(method IN ('cash','transfer','card','unknown'));
 ALTER TABLE trip_expenses ADD COLUMN document_reference text NOT NULL DEFAULT '';
 ALTER TABLE driver_payouts ADD COLUMN shift_id uuid REFERENCES work_shifts(id);
 CREATE TABLE organization_settings(id integer PRIMARY KEY CHECK(id=1),legal_name text NOT NULL DEFAULT '',tax_id text NOT NULL DEFAULT '',registration_number text NOT NULL DEFAULT '',address text NOT NULL DEFAULT '',country text NOT NULL DEFAULT '',tax_regime text NOT NULL DEFAULT '',business_model text NOT NULL DEFAULT 'unspecified' CHECK(business_model IN ('carrier','agent','unspecified')),version integer NOT NULL DEFAULT 1);
 INSERT INTO organization_settings(id) VALUES(1);
 CREATE TABLE report_documents(id uuid PRIMARY KEY,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),period_from date NOT NULL,period_to date NOT NULL,CHECK(period_from<=period_to),payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),sha256 text NOT NULL CHECK(length(sha256)=64),previous_id uuid);
 CREATE TABLE telegram_events(id uuid PRIMARY KEY,event_key text NOT NULL UNIQUE,kind text NOT NULL CHECK(kind IN ('booking.cancelled','booking.refunded','trip.cancelled','report.document')),entity_id uuid NOT NULL,settings_version integer NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),attempts integer NOT NULL DEFAULT 0,last_error text,created_at timestamptz NOT NULL DEFAULT now(),next_attempt_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz);
 CREATE INDEX telegram_events_pending ON telegram_events(status,next_attempt_at);
 CREATE TABLE cash_adjustments(id uuid PRIMARY KEY,shift_id uuid NOT NULL REFERENCES work_shifts(id),currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),amount_minor integer NOT NULL CHECK(amount_minor<>0),reason text NOT NULL CHECK(length(reason)>=10),document_reference text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE auth_rate_windows(bucket text PRIMARY KEY,window_start timestamptz NOT NULL DEFAULT now(),attempts integer NOT NULL DEFAULT 0);
 CREATE SCHEMA IF NOT EXISTS karven_archive;
 CREATE TABLE IF NOT EXISTS karven_archive.event_log(id uuid PRIMARY KEY,entity_id uuid NOT NULL,action text NOT NULL,details jsonb NOT NULL,actor_id uuid,actor_name text,created_at timestamptz NOT NULL,archived_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE karven_archive.event_log ENABLE ROW LEVEL SECURITY;
 INSERT INTO karven_archive.event_log(id,entity_id,action,details,actor_id,actor_name,created_at) SELECT a.id,a.entity_id,a.action,a.details,a.actor_id,u.name,a.created_at FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ON CONFLICT(id) DO NOTHING;
 EXECUTE format('CREATE OR REPLACE FUNCTION karven_archive.preserve_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$ BEGIN INSERT INTO karven_archive.event_log(id,entity_id,action,details,actor_id,actor_name,created_at) VALUES(NEW.id,NEW.entity_id,NEW.action,NEW.details,NEW.actor_id,(SELECT name FROM %I.users WHERE id=NEW.actor_id),NEW.created_at) ON CONFLICT(id) DO NOTHING;RETURN NEW;END $body$',current_schema());
 CREATE TABLE IF NOT EXISTS karven_archive.report_documents(id uuid PRIMARY KEY,created_at timestamptz NOT NULL,payload jsonb NOT NULL,sha256 text NOT NULL);
 ALTER TABLE karven_archive.report_documents ENABLE ROW LEVEL SECURITY;
 EXECUTE $fn$ CREATE OR REPLACE FUNCTION karven_archive.preserve_document() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $body$ BEGIN INSERT INTO karven_archive.report_documents(id,created_at,payload,sha256) VALUES(NEW.id,NEW.created_at,NEW.payload,NEW.sha256) ON CONFLICT(id) DO NOTHING;RETURN NEW;END $body$ $fn$;
 CREATE TRIGGER preserve_report_document AFTER INSERT ON report_documents FOR EACH ROW EXECUTE FUNCTION karven_archive.preserve_document();
 CREATE TRIGGER preserve_audit_event AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION karven_archive.preserve_event();
 INSERT INTO schema_migrations(version) VALUES(10);
END IF;
END $$;

$karven_schema$;
 EXECUTE $karven_archive$
CREATE SCHEMA IF NOT EXISTS karven_archive;
 CREATE TABLE IF NOT EXISTS karven_archive.backups(id uuid PRIMARY KEY,metadata jsonb NOT NULL,payload bytea NOT NULL CHECK(octet_length(payload)<=67108864));
 ALTER TABLE karven_archive.backups ENABLE ROW LEVEL SECURITY;
$karven_archive$;
 EXECUTE $karven_access$
REVOKE ALL ON ALL TABLES IN SCHEMA karven FROM PUBLIC;REVOKE ALL ON SCHEMA karven_archive FROM PUBLIC;REVOKE ALL ON ALL TABLES IN SCHEMA karven_archive FROM PUBLIC;
   DO $$ DECLARE role_name text; table_name text; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
     IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA karven FROM %I',role_name);EXECUTE format('REVOKE ALL ON SCHEMA karven_archive FROM %I',role_name);EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA karven_archive FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA karven FROM %I',role_name);
     END IF;
    END LOOP;
    FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname='karven' LOOP EXECUTE format('ALTER TABLE karven.%I ENABLE ROW LEVEL SECURITY',table_name); END LOOP;
   END $$;
$karven_access$;
 RAISE NOTICE 'KARVEN: installation complete, schema version 10';
END
$karven_install$;
