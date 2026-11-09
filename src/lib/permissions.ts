import {AccessError,type Actor} from './access';
const ownerActions=new Set(['user','userStatus','resetPassword','telegramSave','telegramDisconnect','telegramTest','telegramRetry','eventRetry','organization','reportCreate','reportSend','backupCreate','backupVerify']);
const managerActions=new Set(['trip','booking','bookingDetails','payment','cancel','cancelTrip','refund','cancellationReturn','completeTrip','expense','voidExpense','approveSettlement','payout','driver','vehicle','assign','client','clientNote','task','transferBooking','resizeBooking','attendance','parkSettings','routeTemplate','shiftOpen','shiftClose','cashTransfer','cashTransferDecide','cashAdjust']);
export function authorizeMutation(actor:Actor,action:string){
 if(actor.role==='owner'&&ownerActions.has(action)||actor.role==='dispatcher'&&managerActions.has(action)||actor.role==='driver'&&action==='attendance')return;
 throw new AccessError();
}
