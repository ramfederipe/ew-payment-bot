const DEFAULT_SYNC_COLUMN_MAP = {
  agentNumber: "AGENT NUMBER",
  depositId: "DEPOSIT ID",
  referenceNo: "REFERENCE NO",
  customerNumber: "CUSTOMER NUMBER",
  agentName: "AGENT NAME",
  username: "USERNAME",
  amount: "AMOUNT",
  depositDate: "DEPOSIT DATE",
  imageLink: "IMAGELINK",
  datePosted: "DATE POSTED",
  date: "DATE",
  essStatus: "ESS STATUS",
  videoLink: "VDO LINK, VIDEO, VIDEO LINK",
  videoStatus: "STATUS",
  trxId: "TRX ID"
};

const DEFAULT_UPDATE_COLUMN_MAP = {
  lookupRef: "REFERENCE NO",
  essStatus: "ESS STATUS",
  essSuccessId: "ESS SUCCESS ID",
  trxId: "TRX ID"
};

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function columnLetterToIndex(value) {
  const letters = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(letters)) return -1;

  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }

  return index - 1;
}

function columnIndexToLetter(index) {
  let value = Number(index) + 1;
  let letters = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }

  return letters || "A";
}

function parseColumnMap(raw, defaults = {}) {
  if (!raw) return { ...defaults };

  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { ...defaults, ...(parsed || {}) };
  } catch (err) {
    console.error("Failed to parse sheet column map:", err.message);
    return { ...defaults };
  }
}

function getColumnIndex(headers, selector) {
  const selectors = Array.isArray(selector)
    ? selector
    : String(selector || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);

  for (const item of selectors) {
    const normalized = normalizeHeader(item);
    const byHeader = headers.findIndex(header => normalizeHeader(header) === normalized);
    if (byHeader !== -1) return byHeader;

    const byLetter = columnLetterToIndex(item);
    if (byLetter !== -1) return byLetter;
  }

  return -1;
}

function getByColumnMap(row, headers, map, key) {
  const index = getColumnIndex(headers, map[key]);
  return index !== -1 ? row[index] : "";
}

module.exports = {
  DEFAULT_SYNC_COLUMN_MAP,
  DEFAULT_UPDATE_COLUMN_MAP,
  columnIndexToLetter,
  getByColumnMap,
  getColumnIndex,
  parseColumnMap
};
