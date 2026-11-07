import { z } from 'zod';
const name=z.string().trim().min(1,'Укажите имя').max(120);
export const phoneInput=z.string().trim().regex(/^\+?[\d ()-]{7,25}$/,'Укажите телефон с кодом страны').transform(s=>s.replace(/\D/g,'')).refine(s=>s.length>=7&&s.length<=15,'Телефон должен содержать от 7 до 15 цифр');
export const passengerInput=z.object({name,phone:z.union([phoneInput,z.literal('')]).default('')});
export type Passenger=z.infer<typeof passengerInput>;
export const detailsInput=z.object({
 name,phone:phoneInput,pickupAddress:z.string().trim().max(500).default(''),
 dropoffAddress:z.string().trim().max(500).default(''),luggage:z.string().trim().max(500).default(''),
 childSeats:z.coerce.number().int().min(0).max(60).default(0),
 source:z.enum(['phone','whatsapp','telegram','website','aggregator','other']).default('other'),
 passengers:z.array(passengerInput).min(1).max(60).optional(),
});
