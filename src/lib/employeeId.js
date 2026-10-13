function formatEmployeeId(seq) {
  return `BZ-${String(seq).padStart(4, "0")}`;
}

module.exports = { formatEmployeeId };