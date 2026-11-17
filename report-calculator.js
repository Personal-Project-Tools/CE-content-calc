/**
 * Isomorphic (Chrome MV3 Service Worker + Node.js) Excel (.xlsx) calculator
 * for TikTok Content Live & TikTok Content Video metrics.
 * Zero external dependencies.
 */
(function (root) {
  'use strict';

  const CONTENT_TYPES = {
    live: 'TikTok Content Live',
    video: 'TikTok Content Video'
  };

  const METRIC_RULES = {
    live: {
      revenue: {
        headers: ['LIVE-attributed GMV'],
        fallbackIndex: 5
      },
      product_impression: {
        headers: ['Product Impressions'],
        fallbackIndex: 25
      },
      impression: {
        headers: ['Views'],
        fallbackIndex: 19
      }
    },
    video: {
      revenue: {
        headers: ['Video-attributed GMV'],
        fallbackIndex: 22
      },
      product_impression: {
        headers: ['Product Impressions'],
        fallbackIndex: 13
      },
      impression: {
        headers: ['Video Views', 'Video views', 'VV'],
        fallbackIndex: 7
      }
    }
  };

  // --- XML & Column Helpers ---

  function decodeXmlEntities(str) {
    return String(str || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, '&');
  }

  function escapeXml(str) {
    return String(str ?? '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function colRefToZeroBasedIndex(cellRef) {
    const letters = String(cellRef || '')
      .replace(/\d+/g, '')
      .toUpperCase();
    if (!letters) return -1;
    let idx = 0;
    for (let i = 0; i < letters.length; i++) {
      idx = idx * 26 + (letters.charCodeAt(i) - 64);
    }
    return idx - 1;
  }

  function zeroBasedIndexToColLetters(index) {
    let n = index + 1;
    let letters = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      letters = String.fromCharCode(65 + rem) + letters;
      n = Math.floor((n - 1) / 26);
    }
    return letters;
  }

  // --- Minimal ZIP Reader & Writer ---

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function readZipEntries(zipUint8) {
    const view = new DataView(zipUint8.buffer, zipUint8.byteOffset, zipUint8.byteLength);
    const decoder = new TextDecoder('utf-8');

    let eocdOffset = -1;
    const minOffset = Math.max(0, zipUint8.length - 65558);
    for (let pos = zipUint8.length - 22; pos >= minOffset; pos--) {
      if (view.getUint32(pos, true) === 0x06054b50) {
        eocdOffset = pos;
        break;
      }
    }
    if (eocdOffset < 0) {
      throw new Error('Invalid ZIP/XLSX archive (EOCD not found)');
    }

    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const entries = {};
    let pos = cdOffset;

    for (let i = 0; i < totalEntries; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const method = view.getUint16(pos + 10, true);
      const compSize = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localHeaderOffset = view.getUint32(pos + 42, true);

      const name = decoder.decode(zipUint8.subarray(pos + 46, pos + 46 + nameLen));
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressed = zipUint8.subarray(dataStart, dataStart + compSize);

      entries[name] = { method, data: compressed };
      pos += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
  }

  async function inflateRawWeb(compressedBytes) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressedBytes]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    }
    throw new Error('DecompressionStream(deflate-raw) is not available in this runtime');
  }

  async function getZipEntryTextAsync(entries, entryName, inflateFn) {
    const entry = entries[entryName];
    if (!entry) return null;
    const decoder = new TextDecoder('utf-8');
    if (entry.method === 0) {
      return decoder.decode(entry.data);
    }
    if (entry.method === 8) {
      const inflater = inflateFn || inflateRawWeb;
      const inflated = await inflater(entry.data);
      return decoder.decode(inflated);
    }
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entryName}`);
  }

  function buildZipUint8(files) {
    const encoder = new TextEncoder();
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes =
        typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
      const checksum = crc32(dataBytes);
      const size = dataBytes.length;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
      lv.setUint16(8, 0, true); // method 0 = STORED
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x5421, true);
      lv.setUint32(14, checksum, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      localChunks.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x5421, true);
      cv.setUint32(16, checksum, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);

      centralChunks.push(centralHeader);
      offset += localHeader.length + dataBytes.length;
    }

    let cdSize = 0;
    for (const chunk of centralChunks) cdSize += chunk.length;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const totalLength = offset + cdSize + eocd.length;
    const output = new Uint8Array(totalLength);
    let cursor = 0;
    for (const chunk of localChunks) {
      output.set(chunk, cursor);
      cursor += chunk.length;
    }
    for (const chunk of centralChunks) {
      output.set(chunk, cursor);
      cursor += chunk.length;
    }
    output.set(eocd, cursor);
    return output;
  }

  // --- XLSX Parsing & Metric Calculation ---

  function parseSharedStringsXml(xmlText) {
    if (!xmlText) return [];
    const strings = [];
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(xmlText)) !== null) {
      const inner = siMatch[1];
      let combined = '';
      const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let tMatch;
      while ((tMatch = tRegex.exec(inner)) !== null) {
        combined += decodeXmlEntities(tMatch[1]);
      }
      strings.push(combined);
    }
    return strings;
  }

  function parseWorksheetRowsXml(sheetXml, sharedStrings = []) {
    const rows = [];
    const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
      const rowBody = rowMatch[2];
      const cellMap = new Map();
      let maxCol = -1;
      let sequentialCol = 0;

      const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cellMatch;

      while ((cellMatch = cellRegex.exec(rowBody)) !== null) {
        const attrs = cellMatch[1] || '';
        const body = cellMatch[2] || '';

        const refMatch = attrs.match(/\br="([^"]+)"/);
        let colIdx = refMatch ? colRefToZeroBasedIndex(refMatch[1]) : -1;
        if (colIdx < 0) colIdx = sequentialCol;
        sequentialCol = colIdx + 1;
        if (colIdx > maxCol) maxCol = colIdx;

        const typeMatch = attrs.match(/\bt="([^"]+)"/);
        const cellType = typeMatch ? typeMatch[1] : '';

        let value = '';
        const isMatch = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
        if (isMatch) {
          const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
          let tMatch;
          while ((tMatch = tRegex.exec(isMatch[1])) !== null) {
            value += decodeXmlEntities(tMatch[1]);
          }
        } else {
          const vMatch = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
          if (vMatch) {
            const rawV = decodeXmlEntities(vMatch[1]);
            if (cellType === 's') {
              const ssIdx = parseInt(rawV, 10);
              value = sharedStrings[ssIdx] !== undefined ? sharedStrings[ssIdx] : '';
            } else {
              value = rawV;
            }
          }
        }

        cellMap.set(colIdx, value);
      }

      if (maxCol >= 0) {
        const rowValues = new Array(maxCol + 1).fill('');
        for (const [colIdx, val] of cellMap.entries()) {
          rowValues[colIdx] = val;
        }
        rows.push(rowValues);
      }
    }

    return rows;
  }

  async function readXlsxSheetRowsFromBytes(bytes, inflateFn) {
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const entries = readZipEntries(uint8);
    const sharedStringsXml = await getZipEntryTextAsync(
      entries,
      'xl/sharedStrings.xml',
      inflateFn
    );
    const sharedStrings = parseSharedStringsXml(sharedStringsXml);

    const sheetName = entries['xl/worksheets/sheet1.xml']
      ? 'xl/worksheets/sheet1.xml'
      : Object.keys(entries).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));

    if (!sheetName) {
      throw new Error('No worksheet XML found inside .xlsx archive');
    }

    const sheetXml = await getZipEntryTextAsync(entries, sheetName, inflateFn);
    return parseWorksheetRowsXml(sheetXml, sharedStrings);
  }

  function normalizeHeaderName(raw) {
    return String(raw || '')
      .replace(/\s*\([^)]*\)\s*$/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  function resolveColumnIndex(headers, matchNames, fallbackZeroBased) {
    const targets = matchNames.map((n) => normalizeHeaderName(n));

    for (let i = 0; i < headers.length; i++) {
      const norm = normalizeHeaderName(headers[i]);
      if (!norm) continue;
      if (targets.includes(norm)) {
        return { index: i, headerName: headers[i], matchedBy: 'header' };
      }
    }

    for (let i = 0; i < headers.length; i++) {
      const norm = normalizeHeaderName(headers[i]);
      if (!norm) continue;
      if (targets.some((t) => t.length >= 5 && norm.startsWith(t))) {
        return { index: i, headerName: headers[i], matchedBy: 'header' };
      }
    }

    return {
      index: fallbackZeroBased,
      headerName: headers[fallbackZeroBased] || `Col[${fallbackZeroBased}]`,
      matchedBy: 'fallback'
    };
  }

  function parseNumericCell(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
    const text = String(raw ?? '').trim();
    if (!text) return 0;
    const cleaned = text.replace(/[^0-9.-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : 0;
  }

  function computeMetricsFromRows(rows, contentTypeKey) {
    const rules = METRIC_RULES[contentTypeKey];
    const headerIdx = rows.findIndex(
      (r) => r.filter((v) => String(v || '').trim() !== '').length >= 5
    );

    if (headerIdx < 0) {
      return {
        dataRows: 0,
        revenue: 0,
        product_impression: 0,
        impression: 0,
        matchedColumns: 'No header row found'
      };
    }

    const headers = rows[headerIdx];
    const revCol = resolveColumnIndex(headers, rules.revenue.headers, rules.revenue.fallbackIndex);
    const piCol = resolveColumnIndex(
      headers,
      rules.product_impression.headers,
      rules.product_impression.fallbackIndex
    );
    const impCol = resolveColumnIndex(
      headers,
      rules.impression.headers,
      rules.impression.fallbackIndex
    );

    let revSum = 0;
    let piSum = 0;
    let impSum = 0;
    let dataRows = 0;

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((cell) => String(cell || '').trim() === '')) continue;
      dataRows++;
      if (revCol.index < row.length) revSum += parseNumericCell(row[revCol.index]);
      if (piCol.index < row.length) piSum += parseNumericCell(row[piCol.index]);
      if (impCol.index < row.length) impSum += parseNumericCell(row[impCol.index]);
    }

    return {
      dataRows,
      revenue: Math.round(revSum * 100) / 100,
      product_impression: Math.round(piSum),
      impression: Math.round(impSum),
      matchedColumns: [
        `rev=${revCol.headerName}[${revCol.index},${revCol.matchedBy}]`,
        `pi=${piCol.headerName}[${piCol.index},${piCol.matchedBy}]`,
        `imp=${impCol.headerName}[${impCol.index},${impCol.matchedBy}]`
      ].join('; ')
    };
  }

  function classifyReportFilename(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (lower.startsWith('summary')) return null;
    if (!lower.endsWith('.xlsx')) return null;
    if (lower.startsWith('1_') || lower.startsWith('2_') || lower.includes('live')) return 'live';
    if (lower.startsWith('3_') || lower.startsWith('4_') || lower.includes('video')) return 'video';
    return null;
  }

  // --- OpenXML Workbook Builder ---

  function buildWorksheetXml(sheet) {
    const cols = sheet.colWidths || [];
    const colsXml =
      cols.length > 0
        ? `<cols>${cols
            .map(
              (w, idx) =>
                `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`
            )
            .join('')}</cols>`
        : '';

    const rowsXml = sheet.rows
      .map((row, rIdx) => {
        const rowNum = rIdx + 1;
        const cellsXml = row
          .map((cell, cIdx) => {
            const ref = `${zeroBasedIndexToColLetters(cIdx)}${rowNum}`;
            if (cell && typeof cell === 'object' && cell.type === 'number') {
              const styleAttr = cell.style ? ` s="${cell.style}"` : '';
              const numVal = Number.isFinite(cell.value) ? cell.value : 0;
              return `<c r="${ref}"${styleAttr}><v>${numVal}</v></c>`;
            }
            const strVal = cell && typeof cell === 'object' ? cell.value : cell;
            const styleAttr =
              cell && typeof cell === 'object' && cell.style ? ` s="${cell.style}"` : '';
            return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t>${escapeXml(
              strVal ?? ''
            )}</t></is></c>`;
          })
          .join('');
        return `<row r="${rowNum}">${cellsXml}</row>`;
      })
      .join('');

    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      colsXml +
      `<sheetData>${rowsXml}</sheetData>` +
      `</worksheet>`
    );
  }

  function buildWorkbookXlsxUint8(sheets) {
    const contentTypesOverrides = sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join('');

    const contentTypesXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      contentTypesOverrides +
      `</Types>`;

    const rootRelsXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`;

    const sheetTags = sheets
      .map(
        (s, i) =>
          `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
      )
      .join('');

    const workbookXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheetTags}</sheets>` +
      `</workbook>`;

    const sheetRels = sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join('');

    const stylesRelId = `rId${sheets.length + 1}`;
    const workbookRelsXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheetRels +
      `<Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`;

    // Styles: 0=default, 1=bold header with tint, 2=#,##0.00 decimal, 3=#,##0 integer
    const stylesXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="2">` +
      `<font><sz val="11"/><name val="Calibri"/></font>` +
      `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
      `</fonts>` +
      `<fills count="3">` +
      `<fill><patternFill patternType="none"/></fill>` +
      `<fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/></patternFill></fill>` +
      `</fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="4">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
      `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
      `</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`;

    const zipFiles = [
      { name: '[Content_Types].xml', content: contentTypesXml },
      { name: '_rels/.rels', content: rootRelsXml },
      { name: 'xl/workbook.xml', content: workbookXml },
      { name: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
      { name: 'xl/styles.xml', content: stylesXml }
    ];

    sheets.forEach((sheet, i) => {
      zipFiles.push({
        name: `xl/worksheets/sheet${i + 1}.xml`,
        content: buildWorksheetXml(sheet)
      });
    });

    return buildZipUint8(zipFiles);
  }

  function buildWorkbookFromSummaryData(summaryRows, breakdownRows) {
    const summaryHeader = [
      { value: 'Seller ID', style: 1 },
      { value: 'Period', style: 1 },
      { value: 'Content Type', style: 1 },
      { value: 'revenue', style: 1 },
      { value: 'product_impression', style: 1 },
      { value: 'impression', style: 1 },
      { value: 'Files Included', style: 1 }
    ];

    const summarySheetRows = [
      summaryHeader,
      ...summaryRows.map((r) => [
        r.sellerId,
        r.period,
        r.contentType,
        { type: 'number', value: r.revenue, style: 2 },
        { type: 'number', value: r.product_impression, style: 3 },
        { type: 'number', value: r.impression, style: 3 },
        r.filesIncluded
      ])
    ];

    const breakdownHeader = [
      { value: 'Seller ID', style: 1 },
      { value: 'Period', style: 1 },
      { value: 'File Name', style: 1 },
      { value: 'Content Type', style: 1 },
      { value: 'Data Rows', style: 1 },
      { value: 'revenue', style: 1 },
      { value: 'product_impression', style: 1 },
      { value: 'impression', style: 1 },
      { value: 'Matched Columns', style: 1 }
    ];

    const breakdownSheetRows = [
      breakdownHeader,
      ...breakdownRows.map((b) => [
        b.sellerId,
        b.period,
        b.fileName,
        b.contentType,
        { type: 'number', value: b.dataRows, style: 3 },
        { type: 'number', value: b.revenue, style: 2 },
        { type: 'number', value: b.product_impression, style: 3 },
        { type: 'number', value: b.impression, style: 3 },
        b.matchedColumns
      ])
    ];

    return buildWorkbookXlsxUint8([
      {
        name: 'Summary',
        colWidths: [28, 14, 24, 16, 20, 16, 48],
        rows: summarySheetRows
      },
      {
        name: 'File_Breakdown',
        colWidths: [28, 14, 24, 24, 12, 16, 20, 16, 72],
        rows: breakdownSheetRows
      }
    ]);
  }

  async function aggregateReportEntries(sellerId, period, fileEntries, inflateFn) {
    const accumulators = {
      live: { revenue: 0, product_impression: 0, impression: 0, files: [] },
      video: { revenue: 0, product_impression: 0, impression: 0, files: [] }
    };
    const breakdownRows = [];

    for (const entry of fileEntries) {
      const contentKey = entry.contentKey || classifyReportFilename(entry.fileName);
      if (!contentKey) continue;

      const rows = await readXlsxSheetRowsFromBytes(entry.bytes, inflateFn);
      const metrics = computeMetricsFromRows(rows, contentKey);

      accumulators[contentKey].revenue += metrics.revenue;
      accumulators[contentKey].product_impression += metrics.product_impression;
      accumulators[contentKey].impression += metrics.impression;
      accumulators[contentKey].files.push(entry.fileName);

      breakdownRows.push({
        sellerId,
        period,
        fileName: entry.fileName,
        contentType: CONTENT_TYPES[contentKey],
        dataRows: metrics.dataRows,
        revenue: metrics.revenue,
        product_impression: metrics.product_impression,
        impression: metrics.impression,
        matchedColumns: metrics.matchedColumns
      });
    }

    const summaryRows = ['live', 'video'].map((key) => ({
      sellerId,
      period,
      contentType: CONTENT_TYPES[key],
      revenue: Math.round(accumulators[key].revenue * 100) / 100,
      product_impression: Math.round(accumulators[key].product_impression),
      impression: Math.round(accumulators[key].impression),
      filesIncluded:
        accumulators[key].files.length > 0 ? accumulators[key].files.join(', ') : '(No files)'
    }));

    return { summaryRows, breakdownRows };
  }

  const api = {
    CONTENT_TYPES,
    METRIC_RULES,
    readXlsxSheetRowsFromBytes,
    computeMetricsFromRows,
    classifyReportFilename,
    buildWorkbookXlsxUint8,
    buildWorkbookFromSummaryData,
    aggregateReportEntries
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ReportCalculator = api;
  }
})(typeof self !== 'undefined' ? self : globalThis);
