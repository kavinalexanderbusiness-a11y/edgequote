import type { PilotAcceptancePreviewRequest, PilotAcceptanceExpected, PilotAcceptanceReceipt } from '../../src/lib/quotes/pilotQuoteAcceptance'
export const acceptanceCallerId = (n: number) => `84000000-0000-4000-8000-${String(n).padStart(12,'0')}`
export const acceptanceCallerOwner = acceptanceCallerId(1)
export function acceptanceCallerFixture(portal = false) {
  const request: PilotAcceptancePreviewRequest = {version:1,quoteId:acceptanceCallerId(3),optionId:null,
    ...(portal ? {portalToken:'SYNTHETIC_CALLER_TOKEN_NOT_A_CREDENTIAL'} : {})}
  const expected: PilotAcceptanceExpected = {version:1,quoteId:request.quoteId,previewRevision:'a'.repeat(32),priorAcceptanceId:null,priorAcceptanceSeq:null,
    offered:{authorityFence:'b'.repeat(32),public:{quote_id:request.quoteId,customer_name:'Fictional customer',quote_number:'FIXTURE-1',address:'100 Fictional Road',
      service_type:'Native service',notes:'Exact public scope',status:'sent',valid_until:'2099-12-30',initial_price:100,travel_fee:5,addons_total:17,total:122,
      weekly_price:50,biweekly_price:null,monthly_price:null,deposit_type:null,deposit_value:null,selected_option_id:null,options:[],services:[],
      addons:[{id:acceptanceCallerId(5),name:'Included extra',price:17,is_selected:true,sort_order:0}],included_addon_ids:[acceptanceCallerId(5)],
      offered_option_id:null,accepted_amount:122,terms_text:null,gst_percent:5,company_name:'Fictional business',no_charge:false}}}
  const receipt: PilotAcceptanceReceipt = {code:'accepted',quote_id:request.quoteId,acceptance_id:acceptanceCallerId(6),acceptance_seq:1,
    kind:portal?'customer':'owner_on_behalf',source:portal?'portal':'dashboard',actor_id:portal?acceptanceCallerId(2):acceptanceCallerOwner,
    customer_id:acceptanceCallerId(2),accepted_amount:122,selected_option_id:null,addon_ids:[acceptanceCallerId(5)],document_fingerprint:'c'.repeat(32),
    terms_fingerprint:null,previous_acceptance_id:null}
  return {request,expected,receipt,choice:{addonIds:expected.offered.public.included_addon_ids,reason:portal?null:'text_message' as const,
    note:portal?null:'Exact owner note',termsAck:true,clientOperationId:acceptanceCallerId(7)}}
}
