(function () {
  "use strict";

  window.root = window.root || {};

  function text(value, maxLength) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/&/g, "＆")
      .replace(/</g, "‹")
      .replace(/>/g, "›")
      .replace(/"/g, "”")
      .replace(/'/g, "’")
      .slice(0, maxLength || 5000);
  }

  function cleanState(value, depth) {
    depth = depth || 0;
    if (depth > 12) return null;
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.slice(0, 10000).map(function (item) {
      return cleanState(item, depth + 1);
    });
    if (value && typeof value === "object") {
      var out = {};
      Object.keys(value).slice(0, 500).forEach(function (key) {
        if (/^(password|pass|token|apiKey|key|secret)$/i.test(key)) return;
        out[key] = cleanState(value[key], depth + 1);
      });
      return out;
    }
    return value;
  }

  function sheetText(value) {
    var raw = String(value == null ? "" : value).replace(/\r?\n/g, " ");
    if (/^[\t\r]/.test(raw) || /^\s*[=+\-@]/.test(raw)) raw = "'" + raw;
    return raw;
  }

  function csvCell(value) {
    return '"' + sheetText(value).replace(/"/g, '""') + '"';
  }

  function csvRows(value) {
    var input = String(value || "").replace(/^\uFEFF/, ""), quoted = false, counts = {",": 0, ";": 0};
    for (var i = 0; i < input.length; i++) {
      var char = input[i];
      if (char === '"') {
        if (quoted && input[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted && (char === "\r" || char === "\n")) break;
      else if (!quoted && (char === "," || char === ";")) counts[char]++;
    }
    var delimiter = counts[";"] > counts[","] ? ";" : ",";
    var rows = [], row = [], field = "", inQuotes = false, afterQuote = false;
    function pushRow() {
      row.push(field); field = ""; afterQuote = false;
      if (row.some(function (cell) { return cell.trim(); })) rows.push(row);
      row = [];
    }
    for (var j = 0; j < input.length; j++) {
      var c = input[j];
      if (inQuotes) {
        if (c === '"' && input[j + 1] === '"') { field += '"'; j++; }
        else if (c === '"') { inQuotes = false; afterQuote = true; }
        else field += c;
      } else if (c === delimiter) {
        row.push(field); field = ""; afterQuote = false;
      } else if (c === "\r" || c === "\n") {
        if (c === "\r" && input[j + 1] === "\n") j++;
        pushRow();
        if (rows.length >= 1001) break;
      } else if (c === '"') {
        if (field || afterQuote) throw new Error("CSV invalide");
        inQuotes = true;
      } else if (afterQuote) {
        if (c !== " " && c !== "\t") throw new Error("CSV invalide");
      } else field += c;
    }
    if (inQuotes) throw new Error("CSV invalide");
    if (row.length || field || afterQuote) pushRow();
    if (rows.some(function (item) { return item.length !== rows[0].length; })) throw new Error("CSV invalide");
    return rows;
  }

  function random() {
    var value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] / 4294967296;
  }

  function domain(value) {
    var input = String(value || "").trim().toLowerCase();
    if (input.length > 253) return "";
    try {
      var url = new URL(input.indexOf("://") >= 0 ? input : "https://" + input);
      var host = url.hostname.replace(/\.$/, "");
      if (url.username || url.password || url.port) return "";
      if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "";
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.indexOf(":") >= 0) return "";
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return "";
      return host;
    } catch (error) {
      return "";
    }
  }

  window.KlirSecurity = {
    text: text,
    cleanState: cleanState,
    csvCell: csvCell,
    csvRows: csvRows,
    sheetText: sheetText,
    random: random,
    domain: domain,
    maxImportBytes: 1024 * 1024
  };
}());
