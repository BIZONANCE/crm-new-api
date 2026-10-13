// Decides which section a brand-new lead belongs to.
// Same rules as PUT /leads/:id:
//   Call status "Deal Closed" (CLOSED)  -> DSR
//   Response "Fresh Data" or nothing    -> FRESH
//   Any other response / call status    -> DCR  (New Customer, HFU, WFU, CFU, NI ...)
function sectionForNewLead({ response, meetingStatus } = {}) {
  const resp = String(response || "").trim();
  const status = String(meetingStatus || "").trim();
  if (status === "CLOSED") return "DSR";
  if (resp === "Fresh Data") return "FRESH";
  if (resp || status) return "DCR";
  return "FRESH";
}

module.exports = { sectionForNewLead };
