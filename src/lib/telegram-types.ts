export type TelegramDelivery={booking_id:string;status:'pending'|'sending'|'sent'|'failed'|'unknown'|'cancelled';attempts:number;last_error:string|null;created_at:string;sent_at:string|null};
export type TelegramView={enabled:boolean;tokenConfigured:boolean;chatId:string;version:number;lastTestAt:string|null;lastTestError:string|null;deliveries:TelegramDelivery[]};
export const emptyTelegram:TelegramView={enabled:false,tokenConfigured:false,chatId:'',version:1,lastTestAt:null,lastTestError:null,deliveries:[]};
