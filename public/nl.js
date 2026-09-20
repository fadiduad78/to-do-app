/* =========================================================
 * ZeroTodo — Natural-language quick add  (public/nl.js)
 * ---------------------------------------------------------
 * Turns one line of English into STRUCTURED task data:
 *   { title, description, dueDate, dueTime, priority, projectId,
 *     tags, recurrence, recurRule, remRows, confidence, notes }
 *
 * Doctrine (same as every ZeroTodo module): this file only
 * ever UNDERSTANDS — it has no write path at all. The app
 * renders an “I understood: …” card from the parse and nothing
 * happens until the user presses [Create task] or edits and
 * saves. An ambiguous parse therefore CANNOT silently become a
 * task; it can only silently become a SUGGESTION.
 *
 *  - 100% local, deterministic, offline. No network, no keys.
 *  - Dates/times use LOCAL Date methods only: the user's
 *    timezone is the only timezone in the pipeline.
 *  - Every invented value (bare “7” → 7 PM, “this weekend” →
 *    Saturday, …) pushes a visible note and drops confidence
 *    to 'low' — the card shows exactly what was guessed.
 * ========================================================= */
(function (global) {
  'use strict';

  var WD = [['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6]];
  var MON_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  var WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  var PRESETS = { m5: 5, m10: 10, m15: 15, m30: 30, h1: 60, h2: 120, d1: 1440, d2: 2880 };
  var DAY_WORDS = 'sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function day0(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = day0(d); x.setDate(x.getDate() + n); return x; }
  function wdOf(word) {
    var w = String(word).toLowerCase();
    for (var i = 0; i < WD.length; i++) if (w.indexOf(WD[i][0]) === 0) return WD[i][1];
    return -1;
  }
  /** the coming `wd`; today counts only when allowToday */
  function nextWd(from, wd, allowToday) {
    var d = day0(from), guard = 0;
    while ((d.getDay() !== wd || (!allowToday && d.getTime() === day0(from).getTime())) && guard++ < 8) d = addDays(d, 1);
    return d;
  }

  /**
   * parse(text, { now?: Date, projects?: [{ id, name }] }) → interpretation.
   * `now` is injectable so tests can pin “today” exactly (local zone).
   */
  function parse(input, opts) {
    opts = opts || {};
    var now = opts.now || new Date();
    var today = day0(now);
    var projects = (opts.projects || []).slice().sort(function (a, b) { return String(b.name).length - String(a.name).length; });
    var notes = [];
    var confident = true;
    var out = {
      title: '', description: null, dueDate: null, dueTime: null,
      priority: 'med', projectId: null, projectName: null, tags: [],
      recurrence: '', recurRule: null, remRows: [],
      confidence: 'high', notes: notes,
    };
    var rest = String(input || '').replace(/\s+/g, ' ').replace(/[\u2018\u2019\u02bc]/g, "'").trim();
    if (!rest) { out.confidence = 'low'; notes.push('nothing to parse — type a sentence.'); return out; }
    function tidy() { rest = rest.replace(/\s+/g, ' ').replace(/^[\s,;:.!?-]+/, '').replace(/[\s,;:.!?-]+$/, '').trim(); }
    function eat(m) { rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length); tidy(); }

    /* ---------- #tags ---------- */
    var tagRe = /(?:^|\s)#([\p{L}\p{N}_-]{1,24})/gu, t2;
    var cuts = [];
    while ((t2 = tagRe.exec(rest))) { var tg = t2[1].toLowerCase(); if (out.tags.indexOf(tg) < 0) out.tags.push(tg); cuts.push([t2.index, t2[0].length]); }
    if (cuts.length) { rest = rest.replace(/(?:^|\s)#([\p{L}\p{N}_-]{1,24})/gu, ' '); tidy(); }

    /* ---------- “Create a task …” / “Remind me to …” lead-ins ---------- */
    rest = rest.replace(/^(?:please\s+)?(?:create|make|add)\s+(?:me\s+)?(?:a|an|new|the)?\s*(?:quick\s*)?(?:task|todo)\s*(?:called|named|titled|for|to|that says?)?[:,]?\s*/i, '');
    rest = rest.replace(/^remind me to\s+/i, '');
    tidy();

    /* ---------- priority ---------- */
    var pm2 = /\b(?:set\s+|make\s+it\s+)?(?:very\s+|super\s+)?(?:top|high|hi)\s+priority\b[,!]?\s*/i.exec(rest);
    if (!pm2) pm2 = /\bpriority\s*[:=]\s*(?:top|high)\b[,!]?\s*/i.exec(rest);
    if (pm2) { out.priority = 'high'; eat(pm2); }
    else {
      var urg = /\b(?:it'?s\s+)?(?:very\s+)?(?:urgent|asap)\b[,!]?\s*/i.exec(rest);
      if (urg) { out.priority = 'high'; notes.push('“' + urg[0].trim().replace(/[,!]$/, '') + '” read as high priority.'); eat(urg); }
    }
    if (out.priority !== 'high') {
      var lo = /\blow(?:est)?\s+priority\b[,!]?\s*/i.exec(rest) || /\bpriority\s*[:=]\s*low\b[,!]?\s*/i.exec(rest) ||
        /[,;]?\s*\b(?:no rush|whenever you get a chance|when(?:ever)? you (?:have the time|get to it|can))\b[,!.]?\s*/i.exec(rest);
      if (lo) { out.priority = 'low'; eat(lo); }
    }
    var mid = /\b(?:normal|medium|mid)\s+priority\b[,!]?\s*/i.exec(rest);
    if (mid) eat(mid);

    /* ---------- recurrence FIRST, so “every Monday” is never eaten as a date.
       Scan a token run after “every” → covers “every Monday, Wednesday and
       Friday”, “every 2 weeks”, “every other day”, “every weekday”… ------- */
    (function () {
      var re = /\b(?:every|each)\s+/i;
      var m = re.exec(rest);
      while (m) {
        var at = m.index + m[0].length;
        var consumedLen = 0, every = 1, days = [], unit = '', other = false, saw = false;
        var tokRe = /\s*(other|alternate|,|and|&|\/|\d+|[a-z]+)\s*(?:,|and|&|\/)?\s*/gi;
        var tok;
        while ((tok = tokRe.exec(rest.slice(at)))) {
          var raw = tok[1].toLowerCase();
          var isDayTok = false;
          if (raw === 'other' || raw === 'alternate') { other = true; saw = true; isDayTok = true; }
          else if (/^\d+$/.test(raw)) { every = Math.max(every, Math.min(99, parseInt(raw, 10))); saw = true; isDayTok = true; }
          else {
            var idx = -1;
            if (/^(?:sun|mon|tue|wed|thu|fri|sat)/.test(raw)) idx = wdOf(raw);
            if (idx >= 0) { if (days.indexOf(idx) < 0) days.push(idx); saw = true; isDayTok = true; }
            else if (/^days?$/.test(raw)) { unit = unit || 'day'; saw = true; isDayTok = true; }
            else if (/^weeks?$/.test(raw)) { unit = unit || 'week'; saw = true; isDayTok = true; }
            else if (/^months?$/.test(raw)) { unit = unit || 'month'; saw = true; isDayTok = true; }
            else if (/^years?$/.test(raw)) { unit = unit || 'year'; saw = true; isDayTok = true; }
            else if (/^(?:weekdays?|work|working)$/.test(raw)) {
              if (raw === 'work' || raw === 'working') { var nx = /^\s*days?\b/i.test(rest.slice(at + tok.index + tok[0].length)); if (!nx) break; }
              unit = unit || 'weekdays'; saw = true; isDayTok = true;
            }
            else if (/^weekends?$/.test(raw)) { unit = unit || 'weekend'; saw = true; isDayTok = true; }
          }
          consumedLen = tok.index + tok[0].length;
          if (!isDayTok) { consumedLen = tok.index; break; }
          var afterTok = rest.slice(at + consumedLen);
          if (!/^(?:(?:,|and\s+|&|\/)\s*|\s*(?:on\s+)?(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*|\s*(?:days?|weeks?|months?|years?|weekdays?|weekends?)\b|\s*\d+\s*(?:days?|weeks?|months?|years?))/i.test(afterTok)) break;
          if (/^(?:\s*(?:on\s+)?)?$/i.test(afterTok)) break;
        }
        if (saw && (days.length || unit)) {
          consumedLen = Math.max(consumedLen, 0);
          var phraseEnd = at + consumedLen;
          eat({ index: m.index, 0: rest.slice(m.index, phraseEnd) });
          if (other && every === 1) every = 2;
          if (days.length) {
            out.recurrence = 'custom';
            out.recurRule = { unit: 'week', every: every, weekdays: days.sort(function (a, b) { return a - b; }) };
            if (unit && unit !== 'week') notes.push('weekday set repeats weekly (other units need a date pattern).');
          } else if (unit === 'weekend') { out.recurrence = 'custom'; out.recurRule = { unit: 'week', every: 1, weekdays: [0, 6] }; }
          else if (unit === 'weekdays') out.recurrence = 'weekdays';
          else if (unit === 'day') { if (every === 1) out.recurrence = 'daily'; else { out.recurrence = 'custom'; out.recurRule = { unit: 'day', every: every, weekdays: null }; } }
          else if (unit === 'week') { if (every === 1) out.recurrence = 'weekly'; else { out.recurrence = 'custom'; out.recurRule = { unit: 'week', every: every, weekdays: null }; } }
          else if (unit === 'month') { out.recurrence = 'custom'; out.recurRule = { unit: 'month', every: every, weekdays: null }; }
          else if (unit === 'year') { out.recurrence = 'custom'; out.recurRule = { unit: 'year', every: every, weekdays: null }; }
          return;
        }
        var nxt = new RegExp(re.source, 'gi');
        nxt.lastIndex = m.index + 1;
        m = nxt.exec(rest);
      }
      // bare adverbs after the scan
      var adv;
      if (out.recurrence) return;
      if ((adv = /\bdaily\b|\bday\s+by\s+day\b/i.exec(rest))) { out.recurrence = 'daily'; eat(adv); }
      else if ((adv = /\bweekly\b/i.exec(rest))) { out.recurrence = 'weekly'; eat(adv); }
      else if ((adv = /\bmonthly\b/i.exec(rest))) { out.recurrence = 'monthly'; eat(adv); }
      else if ((adv = /\b(?:annually|yearly)\b/i.exec(rest))) { out.recurrence = 'yearly'; eat(adv); }
    })();

    /* ---------- reminders — ONE clause regex so we never steal the TASK’s
       own “at 7pm” (the clause is consumed whole, tail interpreted inside) -- */
    var remClauseRe = new RegExp(
      '\\b(?:with\\s+(?:a\\s+)?(?:remind(?:er)?|reminder)\\b|remind\\s+me\\b(?:\\s+(?:to\\s+me|for\\s+me))?)' +
      '(?:\\s*[:,]?\\s*(?:the\\s+day\\s+before|(?:a|an|\\d+|[a-z]+)\\s*(?:minutes?|mins?|hours?|hrs?|days?)\\s+before(?:\\s+(?:it|the\\s+task|then|tomorrow|today|the\\s+due\\s+(?:date|time)))?|at\\s+the\\s+same\\s+time|exactly\\s+then|at\\s+the\\s+time|at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?))?', 'i');
    var rcm = remClauseRe.exec(rest);
    while (rcm) {
      var tail = rcm[0].toLowerCase();
      var one = /\b(?:the|a|one)\s+day\s+before\b/.exec(tail);
      var off = /\b(\d+|[a-z]+)\s*(minutes?|mins?|hours?|hrs?|days?)\s+before\b/.exec(tail);
      var atT = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/.exec(tail);
      if (one) out.remRows.push({ reminderType: 'd1' });
      else if (off) {
        var qty = parseInt(off[1], 10);
        if (isNaN(qty)) qty = WORD_NUM[off[1]] || 0;
        var mins = qty * (off[2].charAt(0) === 'h' ? 60 : off[2].charAt(0) === 'd' ? 1440 : 1);
        if (qty < 1) { out.remRows.push({ reminderType: 'm10' }); notes.push('“remind me … before” with no amount → 10 min before.'); }
        else {
          var key = null, best = 1e9;
          for (var k in PRESETS) { if (Math.abs(PRESETS[k] - mins) < best) { best = Math.abs(PRESETS[k] - mins); key = k; } }
          out.remRows.push({ reminderType: key });
          if (best > 0) notes.push(qty + ' ' + off[2].replace(/s$/, '') + ' before → nearest preset “' + key.toUpperCase().replace(/^M/, 'min ').replace(/^H/, 'hr ').replace(/^D/, '') + '” — tweak in Edit.');
        }
      }
      else if (/\b(?:same time|exactly then|at the time)\b/.test(tail)) out.remRows.push({ reminderType: 'onTime' });
      else if (atT) {
        var ha = parseInt(atT[1], 10);
        var apa = (atT[3] || '').replace(/\./g, '').trim();
        if (apa === 'pm' && ha < 12) ha += 12;
        if (apa === 'am' && ha === 12) ha = 0;
        if (!apa && ha >= 1 && ha <= 7) { ha += 12; confident = false; notes.push('reminder time “' + atT[1] + '” guessed as evening (' + pad(ha) + ':00).'); }
        if (ha <= 23) {
          var hmt = atT[2] ? Math.min(59, parseInt(atT[2], 10)) : 0;
          out.remRows.push({ reminderType: 'custom', customDate: '', customTime: pad(ha) + ':' + pad(hmt) });
          notes.push('absolute reminder at ' + pad(ha) + ':' + pad(hmt) + ' — it fires on the due date once one is set.');
        }
      }
      else { out.remRows.push({ reminderType: 'm10' }); confident = false; notes.push('“remind me” with no when → 10 minutes before suggested — Edit to change.'); }
      eat(rcm);
      rcm = remClauseRe.exec(rest);
    }

    /* ---------- time of day ---------- */
    var mer = /\b(?:at\s+|by\s+|around\s+|@|starting\s+|from\s+|scheduled\s+for\s+)?(\d{1,2})(?::(\d{2}))?\s*(:\d{2})?\s*([ap])\.?\s?m\.?\b/i.exec(rest);
    var daypart = /\b(?:in\s+the\s+|around\s+the\s+|this\s+)?(morning|afternoon|evening|tonight|night)\b(?:\s+o'?clock)?/i.exec(rest);
    var colon = !mer ? /\b(?:at\s+|by\s+|around\s+|@|starting\s+|from\s+)(\d{1,2}):(\d{2})\b(?![-/]\d)/i.exec(rest) : null;
    var oclock = !mer && !colon ? /\b(?:at\s+|by\s+|around\s+)?(\d{1,2})\s*o'?clock\b/i.exec(rest) : null;
    var bare = !mer && !colon && !oclock ? /\b(?:at|by|around)\s+(\d{1,2})\b(?!\s*(?:[:./]\d|[ap]\.?m?\.?|o'?clock|days?\b|weeks?\b|months?\b|years?\b|minutes?\b|mins?\b|hours?\b|hrs?\b))/i.exec(rest) : null;
    var tset = false;
    var usedDaypart = false;
    function eatDaypart() {
      if (!daypart || usedDaypart || /tonight/i.test(daypart[1])) return; // “tonight” belongs to the DATE pass
      usedDaypart = true;
      var dm = /\b(?:in\s+the\s+|around\s+the\s+|this\s+)?(?:morning|afternoon|evening|night)\b(?:\s+o'?clock)?/i.exec(rest);
      if (dm) eat(dm);
    }
    if (mer) {
      var h = parseInt(mer[1], 10) % 12;
      if (/p/i.test(mer[4])) h += 12;
      var mi = mer[2] ? Math.min(59, parseInt(mer[2], 10)) : 0;
      if (daypart) {
        var dp = daypart[1].toLowerCase();
        if ((dp === 'evening' || dp === 'night') && h < 12) h += 12;
        if (dp === 'afternoon' && h < 12 && h !== 0) h = h + 12 > 23 ? h : h + 12;
        if (dp === 'tonight' && h < 18 && h !== 0) { /* evening-ish: leave as given, the meridiem already disambiguates */ }
      }
      out.dueTime = pad(h) + ':' + pad(mi);
      eat(mer); eatDaypart(); tset = true;
    } else if (colon) {
      var h4 = parseInt(colon[1], 10), m4 = parseInt(colon[2], 10);
      if (h4 <= 23 && m4 <= 59) { out.dueTime = pad(h4) + ':' + pad(m4); eat(colon); eatDaypart(); tset = true; }
      else bare = colon = null;
    }
    if (!tset && oclock) {
      var ho = parseInt(oclock[1], 10);
      if (ho >= 1 && ho <= 7) { out.dueTime = pad(ho + 12) + ':00'; confident = false; notes.push('"' + ho + ' o\u2019clock" read as evening \u2014 guessed ' + pad(ho + 12) + ':00.'); }
      else { out.dueTime = pad(ho === 0 ? 0 : ho % 24) + ':00'; }
      eat(oclock); eatDaypart(); tset = true;
    }
    if (!tset && bare) {
      var hb = parseInt(bare[1], 10);
      if (daypart) {
        var dpb = daypart[1].toLowerCase();
        var h5 = hb % 12;
        if (dpb === 'evening' || dpb === 'night' || dpb === 'tonight') h5 += 12;
        else if (dpb === 'afternoon' && h5 !== 0) h5 += 12;
        out.dueTime = pad(Math.min(23, h5)) + ':00';
      } else if (hb >= 13 && hb <= 23) { out.dueTime = pad(hb) + ':00'; }
      else if (hb === 12) { out.dueTime = '12:00'; }
      else if (hb >= 8 && hb <= 11) { out.dueTime = pad(hb) + ':00'; confident = false; notes.push('bare “' + hb + '” assumed morning — ' + pad(hb) + ':00.'); }
      else if (hb >= 1 && hb <= 7) { out.dueTime = pad(hb + 12) + ':00'; confident = false; notes.push('bare “at ' + hb + '” guessed as ' + pad(hb + 12) + ':00 (evening) — one tap in Edit flips it.'); }
      else { bare = null; }
      if (bare) { eat(bare); eatDaypart(); tset = true; }
    }
    var noon = !tset ? /\b(?:at\s+|by\s+|around\s+|@)?(noon|midday|midnight)\b/i.exec(rest) : null;
    if (!tset && noon) {
      out.dueTime = /midnight/.test(noon[1].toLowerCase()) ? '00:00' : '12:00';
      eat(noon); tset = true;
    }
    if (!tset && daypart) {
      var d3 = daypart[1].toLowerCase();
      out.dueTime = d3 === 'morning' ? '09:00' : d3 === 'afternoon' ? '14:00' : d3 === 'evening' ? '19:00' : '21:00';
      if (d3 === 'tonight') out.dueTime = '20:00';
      confident = false;
      notes.push('“' + d3 + '” without a clock time → ' + out.dueTime + ' guessed.');
      eat(daypart); tset = true;
    } else if (tset && daypart && (daypart[1].toLowerCase() === 'tonight')) eat(daypart);

    /* ---------- due date ---------- */
    var dd = null;
    var relWasPast = false; // an EXPLICIT “yesterday” is not a guess to be rolled forward
    var rel = /\b(?:due\s+|deadline\s+)?(?:is\s+|falls\s+|was\s+)?(the day after tomorrow|day after tomorrow|tomorrow|tmrw|today|tonight|this weekend|next weekend|next week|the day before yesterday|day before yesterday|yesterday)\b(?! (\d|am|pm|o'))/i.exec(rest);
    if (rel) {
      var w = rel[1].toLowerCase();
      if (w.indexOf('after tomorrow') >= 0) dd = addDays(today, 2);
      else if (w.indexOf('before yesterday') >= 0) { dd = addDays(today, -2); relWasPast = true; } // overdue — that is the point of saying it
      else if (w === 'yesterday') { dd = addDays(today, -1); relWasPast = true; }
      else if (w === 'tomorrow' || w === 'tmrw') dd = addDays(today, 1);
      else if (w === 'today') dd = today;
      else if (w === 'tonight') dd = today;
      else if (w === 'next week') { dd = nextWd(today, 1, false); notes.push('“next week” anchored to its Monday.'); }
      else { dd = nextWd(today, 6, /\bnext\b/.test(rel[1])); if (!/\bthis\b/.test(w)) notes.push('“' + w + '” read as the coming Saturday.'); }
      eat(rel);
    }
    var inRe = !dd ? /\bin\s+(\d+|[a-z]+)\s+(days?|weeks?|months?|years?)\b(?:\s+from\s+(?:now|today))?/i.exec(rest) : null;
    if (inRe) {
      var q = parseInt(inRe[1], 10);
      if (isNaN(q)) q = WORD_NUM[inRe[1].toLowerCase()] || 0;
      var uu = inRe[2].toLowerCase().replace(/s$/, '');
      if (q >= 1) {
        var d2 = day0(now);
        if (uu === 'day') d2 = addDays(d2, q);
        else if (uu === 'week') d2 = addDays(d2, q * 7);
        else if (uu === 'month') d2 = new Date(d2.getFullYear(), d2.getMonth() + q, d2.getDate());
        else d2 = new Date(d2.getFullYear() + q, d2.getMonth(), d2.getDate());
        dd = d2; eat(inRe);
      }
    }
    var iso = !dd ? /\b(20\d{2}|19\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(rest) : null;
    if (iso && +iso[2] >= 1 && +iso[2] <= 12 && +iso[3] >= 1 && +iso[3] <= 31) { dd = new Date(+iso[1], +iso[2] - 1, +iso[3]); eat(iso); }
    else if (iso) { dd = null; }
    var moDay = !dd ? /\b(?:on\s+|due\s+|by\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i.exec(rest) : null;
    if (moDay) {
      var mi2 = MON_IDX[moDay[1].toLowerCase().slice(0, 3)];
      var dn2 = parseInt(moDay[2], 10);
      var yr2 = moDay[3] ? parseInt(moDay[3], 10) : now.getFullYear();
      if (mi2 >= 0 && mi2 < 12 && dn2 >= 1 && dn2 <= 31) {
        dd = new Date(yr2, mi2, dn2);
        if (!moDay[3] && dd < today) { dd = new Date(yr2 + 1, mi2, dn2); notes.push('that date already passed this year → planned for ' + (yr2 + 1) + '.'); }
        eat(moDay);
      }
    }
    var moDay2 = !dd ? /\b(?:on\s+|due\s+|by\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/i.exec(rest) : null;
    if (moDay2) {
      var mi3 = MON_IDX[moDay2[2].toLowerCase().slice(0, 3)];
      var dn3 = parseInt(moDay2[1], 10);
      var yr3 = moDay2[3] ? parseInt(moDay2[3], 10) : now.getFullYear();
      if (mi3 >= 0 && mi3 < 12 && dn3 >= 1 && dn3 <= 31) {
        dd = new Date(yr3, mi3, dn3);
        if (!moDay2[3] && dd < today) { dd = new Date(yr3 + 1, mi3, dn3); notes.push('that date already passed this year → planned for ' + (yr3 + 1) + '.'); }
        eat(moDay2);
      }
    }
    var slash = !dd ? /\b(?:on\s+|due\s+|by\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(rest) : null;
    if (slash) {
      var aa = parseInt(slash[1], 10), bb = parseInt(slash[2], 10);
      var moS, daS, yrS = slash[3] ? (+slash[3] < 100 ? 2000 + +slash[3] : +slash[3]) : now.getFullYear();
      if (aa > 12 && bb <= 12) { daS = aa; moS = bb - 1; notes.push('read ' + aa + '/' + bb + ' as day/month.'); }
      else { moS = aa - 1; daS = bb; if (aa <= 12 && bb <= 12) notes.push('“' + aa + '/' + bb + '” is ambiguous → read month/day.'); }
      if (moS >= 0 && moS < 12 && daS >= 1 && daS <= 31) {
        dd = new Date(yrS, moS, daS);
        if (!slash[3] && dd < today) dd = new Date(yrS + 1, moS, daS);
        eat(slash);
      }
    }
    var nth = !dd ? /\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(rest) : null;
    if (nth) {
      var nd = parseInt(nth[1], 10);
      if (nd >= 1 && nd <= 31) { dd = new Date(now.getFullYear(), now.getMonth(), nd); if (dd < today) dd = new Date(dd.getFullYear(), dd.getMonth() + 1, nd); eat(nth); }
    }
    var wk = !dd && !out.recurrence ? new RegExp('\\b(?:on\\s+|due\\s+|by\\s+|starting\\s+)?(next\\s+|this\\s+)?(' + DAY_WORDS + ')\\b', 'i').exec(rest) : null;
    if (wk) {
      var idx = wdOf(wk[2]);
      var isNext = /\bnext\b/i.test(wk[1] || '');
      var cand = nextWd(today, idx, true);
      if (cand < today) cand = addDays(cand, 7);
      if (isNext && cand - today < 4 * 86400000) cand = addDays(cand, 7);
      dd = cand;
      notes.push((isNext ? '“next ' : '“') + wk[2] + '” → ' + ymd(dd) + '.');
      eat(wk);
    }
    if (out.recurrence === 'custom' && out.recurRule && out.recurRule.unit === 'week' && !(out.recurRule.weekdays && out.recurRule.weekdays.length)) {
      var wset = [], wfe = new RegExp('\\b(?:on\\s+|every\\s+)(' + DAY_WORDS + ')\\b', 'gi'), wfd;
      while ((wfd = wfe.exec(rest))) { var wi = wdOf(wfd[1]); if (wi >= 0 && wset.indexOf(wi) < 0) wset.push(wi); }
      if (wset.length) {
        out.recurRule.weekdays = wset.sort(function (a, b) { return a - b; });
        var wm;
        while ((wm = new RegExp('\\b(?:on\\s+|every\\s+)(' + DAY_WORDS + ')\\b', 'i').exec(rest))) eat(wm);
      }
    }
    if (dd && day0(dd) < today && !out.recurrence && !relWasPast) { dd = addDays(day0(dd), 7); notes.push('that date was in the past — moved a week forward.'); }
    if (dd) {
      // clamp nonsense days-of-month
      if (new Date(dd.getFullYear(), dd.getMonth(), dd.getDate()).getMonth() !== dd.getMonth()) dd = new Date(dd.getFullYear(), dd.getMonth() + 1, 0);
      out.dueDate = ymd(dd);
    }

    /* ---------- project (existing names only — never invents one) ---------- */
    for (var pi = 0; pi < projects.length; pi++) {
      var pn = String(projects[pi].name || '').trim();
      if (pn.length < 2) continue;
      var pRe = new RegExp('\\b(?:in|for|on)\\s+(?:the\\s+)?' + pn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?:\\s+project)?\\b[,\\s]*|\\b' + pn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+project\\b[,\\s]*', 'i');
      var pmm = pRe.exec(rest);
      if (pmm) { out.projectId = projects[pi].id; out.projectName = pn; eat(pmm); break; }
    }

    /* ---------- title (and description split) ---------- */
    rest = rest.replace(/[,;]\s*(?:and|plus|also)\s+$/i, '');
    rest = rest.replace(/\s+(?:and|plus)\s+$/i, '');
    rest = rest.replace(/^["'“”]+|["'“”]+$/g, '');
    tidy();
    if (out.dueDate || out.dueTime) rest = rest.replace(/\s+\b(?:tonight|this evening|this morning|this afternoon)\b\s*$/i, '');
    tidy();
    var sep = rest.match(/\s+(?:—|–|\s-\s)\s+|:\s+/);
    if (sep) {
      var headTxt = rest.slice(0, sep.index).trim();
      var tailTxt = rest.slice(sep.index + sep[0].length).trim();
      if (headTxt.length >= 2 && tailTxt.length >= 4 && !/^\d/.test(tailTxt)) { out.description = tailTxt.slice(0, 2000); rest = headTxt; tidy(); }
    }
    if (!rest || rest.length < 2) {
      out.title = String(input || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      confident = false;
      notes.push('couldn’t cleanly split wording from schedule — kept your whole sentence as the title.');
    } else {
      out.title = (rest.charAt(0).toUpperCase() + rest.slice(1)).replace(/\s+/g, ' ').slice(0, 200);
    }
    if (!out.dueDate && !out.dueTime && !out.recurrence) {
      confident = false;
      notes.push('no date found — that is fine; the task simply starts unscheduled.');
    }
    out.confidence = confident ? 'high' : 'low';
    return out;
  }

  var ZTNL = {
    parse: parse,
    ymd: ymd,
    /** pretty labels for the confirmation card — presentation only */
    fmtDay: function (ymdStr, now) {
      if (!ymdStr) return null;
      var d = new Date(+ymdStr.slice(0, 4), +ymdStr.slice(5, 7) - 1, +ymdStr.slice(8, 10));
      var t0 = day0(now || new Date());
      var diff = Math.round((day0(d) - t0) / 86400000);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      var wd = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
      return (diff > 1 && diff < 7 ? wd + ', ' : '') +
        d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== t0.getFullYear() ? 'numeric' : undefined });
    },
    fmtDayFull: function (ymdStr, now) {
      if (!ymdStr) return null;
      var d = new Date(+ymdStr.slice(0, 4), +ymdStr.slice(5, 7) - 1, +ymdStr.slice(8, 10));
      var t0 = day0(now || new Date());
      var diff = Math.round((day0(d) - t0) / 86400000);
      var rel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : null;
      var opts = { month: 'long', day: 'numeric' };
      if (d.getFullYear() !== t0.getFullYear()) opts.year = 'numeric';
      var base = d.toLocaleDateString(undefined, opts);
      if (rel) base += ' (' + rel + ')';
      else if (diff > 1 && diff < 7) base = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] + ', ' + base;
      return base;
    },
    fmtTime: function (t) {
      if (!t) return null;
      var h = +t.slice(0, 2), m = t.slice(3, 5);
      return (h % 12 || 12) + ':' + m + (h >= 12 ? ' PM' : ' AM');
    },
    fmtRepeat: function (p) {
      if (!p.recurrence) return null;
      if (p.recurrence !== 'custom') return { daily: 'Every day', weekdays: 'Every weekday (Mon–Fri)', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' }[p.recurrence] || p.recurrence;
      var r = p.recurRule || {};
      if (r.unit === 'week' && r.weekdays && r.weekdays.length) {
        var names = r.weekdays.map(function (d) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]; });
        return (r.every > 1 ? 'Every ' + r.every + ' weeks' : 'Weekly') + ' on ' + names.join(', ');
      }
      return 'Every ' + (r.every || 1) + ' ' + (r.unit || 'day') + ((r.every || 1) > 1 ? 's' : '');
    },
    REM_LABEL: { onTime: 'At task time', m5: '5 min before', m10: '10 min before', m15: '15 min before', m30: '30 min before', h1: '1 hour before', h2: '2 hours before', d1: '1 day before', d2: '2 days before', custom: 'At a set moment' },
    PRIORITIES: ['low', 'med', 'high'],
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ZTNL; // tests may require it directly
  if (global) global.ZTNL = ZTNL;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
