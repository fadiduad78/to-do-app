/* ==========================================================================
 * ZeroTodo — AI task decomposition (public/ai.js)
 *
 * The brief in one line: when a task is big, offer to "Break this task down
 * with AI" — and let the AI return STRUCTURED TASK DATA (never prose) that
 * the user reviews, edits and explicitly approves. Nothing here ever writes
 * to the task system: this module only plans. Creating the approved subset is
 * app.js's job, through the ordinary task pipeline — an accepted suggestion is
 * just a task, with two advisory extras (estMin, deps) that ride the record.
 *
 * Two engines, one interface (ZTAI.decompose):
 *   • built-in planner — deterministic, domain-aware, always available
 *     (offline, file:// standalone, rate-limited fallback). "AI" here means a
 *     structured planning engine, not a chatbot: its output is an array of
 *     {title, description, estMin, priority, dueDate, dependsOn} — the exact
 *     shape the review UI (and the server) consume.
 *   • server AI service — POST /api/ai/decompose; if the deployment set
 *     ZT_AI_URL/ZT_AI_KEY/ZT_AI_MODEL the server proxies a strict-JSON LLM
 *     call; any failure at all falls back to the built-in planner (the app
 *     must work with zero AI configuration).
 *
 * No API keys ever live in the browser; settings only choose the preference
 * 'auto' vs 'local'.
 * ==========================================================================*/
(function (global) {
  'use strict';

  const PRIORITIES = ['low', 'med', 'high'];
  const MAX_STEPS = 12;

  /* ------------------------- the built-in planner ------------------------- */
  /* Playbooks: matched in order, first hit wins. A step is
     [title, description, estMin, priority, dependsOn...] and deliberately
     mirrors how a senior engineer would slice the work — small front-end
     steps, bigger core step, tests near the end. The expense-tracker
     playbook pins the exact 8-step list from the product brief. */
  const PLAYBOOKS = [
    {
      id: 'expense-app',
      test: (t) => /(expense|budget|spending)/i.test(t) && /(track|tracker|app|log|record|manage)/i.test(t),
      steps: [
        ['Define requirements', 'List must-haves (amount, date, category, totals, filters) and write down non-goals so the build does not sprawl.', 45, 'med', []],
        ['Design data model', 'expense(id, amount, date, category, note) + category(id, name); decide validation rules and rounding.', 60, 'high', [0]],
        ['Create database', 'Set up storage (localStorage/IndexedDB or SQL), run initial schema, seed a few sample rows.', 90, 'high', [1]],
        ['Build expense form', 'Add/edit with validation, delete with confirm; keyboard-friendly and mobile-sized.', 120, 'high', [2]],
        ['Add categories', 'CRUD for categories + assignment in the form; color chips in lists and totals.', 60, 'med', [1]],
        ['Add reports', 'Monthly totals, per-category breakdown, date-range picker — computed from the same records.', 90, 'med', [3]],
        ['Add export', 'CSV/JSON export of the filtered set; empty result handled honestly.', 60, 'low', [5]],
        ['Test application', 'Happy path + edge cases (negative amounts, empty state, DST dates, 12-month range); fix fallout.', 120, 'high', [4, 6]],
      ],
    },
    {
      id: 'backend-api',
      test: (t) => /\b(api|backend|server|endpoint|web ?service)\b/i.test(t) && /(build|create|design|implement|develop)/i.test(t),
      steps: [
        ['Spec endpoints', 'Routes, payloads, status codes, auth contract — written down before code.', 45, 'low', []],
        ['Persistence & migrations', 'Schema for the core tables; reversible migrations; seed script.', 90, 'high', [0]],
        ['Implement handlers', 'CRUD first, then the clever bits; request validation at the edge.', 150, 'high', [1]],
        ['Auth & rate limits', 'Session/token checks, guard rails per bucket; errors in one shape.', 60, 'med', [0]],
        ['Integration tests', 'Happy path + 4xx matrix against a throwaway database.', 90, 'high', [2, 3]],
        ['Deploy & document', 'One README with curl examples; healthcheck wired.', 45, 'low', [4]],
      ],
    },
    {
      id: 'software',
      test: (t) => /(build|create|develop|make|implement|code|write|design)/i.test(t)
        && /(app|application|website|web ?site|site|platform|dashboard|tool|system|clone|game|extension|bot|feature|module|tracker|manager)/i.test(t),
      steps: [
        ['Define requirements', 'Who uses it, for what, in one paragraph; a short non-goals list.', 45, 'med', []],
        ['Sketch data & UI', 'Draw the main screen and the shape of the records — it settles half the build.', 60, 'high', [0]],
        ['Scaffold the project', 'Repo, framework, empty states; something clickable day one.', 90, 'med', [1]],
        ['Build the core flow', 'The ONE feature the app exists for, end to end, no extras yet.', 180, 'high', [2]],
        ['Style & polish', 'Responsive layout, empty/loading states, keyboard focus.', 90, 'med', [3]],
        ['Test key flows', 'Write the 5 flows a demo runs through; make them pass.', 90, 'high', [3]],
        ['Ship & document', 'Deploy, write the README, collect first feedback.', 45, 'low', [4, 5]],
      ],
    },
    {
      id: 'study',
      test: (t) => /(study|learn|prepare|revise|master|cram|course|exam|ielts|toefl|certification|syllabus)/i.test(t),
      steps: [
        ['Assess level & goals', 'One honest sample test or self-check; write the target score/date.', 30, 'med', []],
        ['Build a weekly schedule', 'Fixed slots, realistic load; put it where the app can nag.', 30, 'high', [0]],
        ['Gather resources', 'One primary source + one practice set — resist the hoarding urge.', 45, 'low', [0]],
        ['Core topics deep-work', 'Work the syllabus in blocks; one topic at a time to done.', 240, 'high', [1, 2]],
        ['Deliberate practice', 'Timed problem sets on the weakest topic each session.', 120, 'high', [3]],
        ['Mock exam / checkpoint', 'Full conditions, score it, keep only the findings.', 90, 'med', [4]],
        ['Patch weak spots', 'Target the two worst areas, then re-schedule around them.', 60, 'med', [5]],
      ],
    },
    {
      id: 'writing',
      test: (t) => /(write|writing|essay|article|blog|thesis|dissertation|book|newsletter|documentation|report|proposal|draft)/i.test(t),
      steps: [
        ['Audience & angle', 'One sentence: who reads this and what they should think after.', 30, 'med', []],
        ['Research & sources', 'Gather the 5-10 pieces of evidence worth citing; kill the rest.', 90, 'med', [0]],
        ['Outline sections', 'Headings + one-line promise per section — the contract with the reader.', 45, 'high', [0]],
        ['First draft', 'Ugly and complete beats pretty and stalled; no editing allowed yet.', 180, 'high', [2]],
        ['Revise structure', 'Reorder, cut whole sections; argue with yourself once.', 90, 'med', [3]],
        ['Edit & proofread', 'Sentences, then commas, then read it aloud once.', 60, 'med', [4]],
        ['Publish & share', 'Ship it; note the two things you would fix for next time.', 30, 'low', [5]],
      ],
    },
    {
      id: 'event',
      test: (t) => /(wedding|party|conference|meetup|retreat|trip|vacation|holiday|tour|event|launch ?(party|event)|gathering)/i.test(t),
      steps: [
        ['Budget & list', 'How much, how many — everything downstream unlocks from these two numbers.', 45, 'high', []],
        ['Lock date & venue', 'Two backup dates checked before paying anything.', 60, 'high', [0]],
        ['Book vendors', 'Catering/photo/transport — written confirmations with dates.', 90, 'med', [1]],
        ['Schedule & invites', 'Run-sheet skeleton; invitations out with an RSVP deadline.', 60, 'med', [1]],
        ['Logistics checklist', 'Day-of timeline, contacts, payment plan, weather/backup plan.', 45, 'high', [2, 3]],
        ['Follow-up', 'Photos, thank-yous, expenses settled while it is fresh.', 30, 'low', [4]],
      ],
    },
    {
      id: 'home',
      test: (t) => /(paint|fix|repair|install|assemble|renovate|declutter|deep ?clean|shelf|garage|kitchen|bathroom|garden|landscap)/i.test(t),
      steps: [
        ['Measure & buy', 'Actual measurements, then materials +10% and a tool check.', 60, 'med', []],
        ['Prep the area', 'Move, mask, cover, protect — 30 minutes here saves hours later.', 45, 'med', [0]],
        ['Do the core work', 'The big physical step; take the break you planned.', 120, 'high', [1]],
        ['Finish & details', 'Edges, touch-ups, hardware back on, height/level re-check.', 60, 'med', [2]],
        ['Clean & inspect', 'Tools back where they came from; photograph the result.', 30, 'low', [3]],
      ],
    },
    {
      id: 'generic',
      test: () => true,
      steps: [
        ['Define scope & success', 'One paragraph: done means what, measurably.', 30, 'high', []],
        ['Break down & order', 'List every piece of work you can think of; sequence it roughly.', 30, 'med', [0]],
        ['Prep inputs & tools', 'Access, files, accounts, materials — the boring enablers.', 45, 'med', [1]],
        ['Execute the core', 'The main body of work, one chunk at a time.', 120, 'high', [2]],
        ['Review & fix', 'Compare against “done means what”; close the gap, not the file.', 60, 'med', [3]],
        ['Wrap up & share', 'Deliver, document two lessons learned, archive.', 30, 'low', [4]],
      ],
    },
  ];

  function playbookFor(text) {
    for (const pb of PLAYBOOKS) if (pb.test(text)) return pb;
    return PLAYBOOKS[PLAYBOOKS.length - 1];
  }

  /* ---------------------------- date helpers ------------------------------- */
  /* The engine must not depend on app.js — small self-contained date math. */
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(baseYmd, n) {
    const p = String(baseYmd).split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }
  function todayYmd() { return ymd(new Date()); }

  /** ~4h of focused work fits a day; a step never stretches below 1 day. */
  function daysFor(min) { return Math.max(1, Math.ceil(min / 240)); }

  /**
   * Structured plan for a task (title + description as prose input, data out).
   * `opts`: { start: 'YYYY-MM-DD' | null, seed: 0 } — seed jitters estimates
   * for “Regenerate” without shuffling the dependency order.
   */
  function plan(title, description, opts) {
    const o = opts || {};
    const text = String(title || '') + ' ' + String(description || '');
    const pb = playbookFor(text);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(o.start || '') ? o.start : todayYmd();
    const jitter = [1, 1.25, 0.8, 1.1][Math.abs(Number(o.seed) || 0) % 4] || 1;
    const raw = pb.steps.map((s, i) => {
      const est = Math.min(600, Math.max(5, Math.round(s[2] * (jitter + (i % 3 ? 0 : 0)) / 5) * 5));
      return { idx: i, title: s[0], description: s[1], estMin: est, priority: s[3], dependsOn: (s[4] || []).slice() };
    });
    // schedule: each step ends after its latest dependency + own duration
    const endDay = [];
    for (const s of raw) {
      const startAt = s.dependsOn.length ? Math.max(...s.dependsOn.map((d) => (d < s.idx ? endDay[d] : 0))) : 0;
      endDay[s.idx] = startAt + daysFor(s.estMin);
      s.dueDate = addDays(start, endDay[s.idx] - 1 < 0 ? 0 : endDay[s.idx] - 1);
    }
    return {
      engine: 'built-in planner',
      playbook: pb.id,
      steps: raw.map(({ idx, ...rest }) => rest),
    };
  }

  /* -------------------------- structured-data rules ------------------------- */
  /* One sanitizer for EVERY plan source (built-in, server, LLM JSON): the
     review UI is fed validated data no matter who produced it. This is the
     “return structured task data rather than arbitrary text” contract. */
  function sanitizeStep(s, i) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const title = typeof s.title === 'string' ? s.title.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    if (!title) return null;
    const e = Math.round(Number(s.estMin));
    return {
      title,
      description: typeof s.description === 'string' ? s.description.trim().slice(0, 500) : '',
      estMin: Number.isFinite(e) && e > 0 ? Math.min(10080, Math.max(5, e)) : 60,
      priority: PRIORITIES.indexOf(s.priority) >= 0 ? s.priority : 'med',
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(s.dueDate || '') ? s.dueDate : null,
      _dep: Array.isArray(s.dependsOn) || Array.isArray(s.depends_on) ? (s.dependsOn || s.depends_on) : [],
      _i: i,
    };
  }
  function sanitizePlan(input) {
    const arr = Array.isArray(input) ? input : (input && typeof input === 'object' && Array.isArray(input.steps) ? input.steps : null);
    if (!arr) return null;
    const steps = arr.slice(0, MAX_STEPS).map(sanitizeStep).filter(Boolean);
    if (!steps.length) return null;
    for (const s of steps) {
      s.dependsOn = [...new Set(s._dep.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < steps.length && n !== s._i))];
      delete s._dep; delete s._i;
    }
    return { steps, engine: (input && input.engine) || 'structured', playbook: (input && input.playbook) || null, model: (input && input.model) || '' };
  }

  /* "large task" heuristic — decides when the app OFFERS the breakdown.
     The offer is never automatic work: worst case we nag with a button. */
  const LARGE_RE = /\b(build|create|develop|implement|design|launch|migrate|refactor|rebuild|overhaul|organize|plan|prepare|write|study|learn|research|deploy|ship|set ?up|setup|fix|repair|install|publish|automate|redesign)\b|tracker|\bapp\b|application|website|platform|dashboard|\bapi\b|database|wedding|conference|thesis|dissertation|course|exam/i;
  function looksLarge(title, description) {
    const t = String(title || '').trim();
    if (!t) return false;
    if (LARGE_RE.test(t)) return true;
    if (t.length >= 32) return true;
    if (String(description || '').trim().length >= 120) return true;
    return t.split(/\s+/).length >= 5;
  }

  /** '⏱ 1h30m' style label used by badges and the review UI. */
  function fmtEst(min) {
    const m = Math.round(Number(min) || 0);
    if (!m) return '';
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? h + 'h' + (m % 60) + 'm' : h + 'h';
    const d = Math.floor(h / 24);
    return d + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
  }

  /* ------------------------------ decomposition ----------------------------- */
  /* mode: 'auto' = try the server (which tries a configured LLM and falls
     back to its own built-in planner), 'local' = never leave the device.
     Any server failure at all (offline, file://, 429, malformed) is silent —
     the built-in planner answers, so the feature NEVER dead-ends. */
  async function decompose(task, opts) {
    const o = opts || {};
    const local = () => {
      const p = plan(task.title, task.description, { start: task.dueDate || null, seed: o.seed || 0 });
      return sanitizePlan(p);
    };
    const wantServer = o.mode !== 'local' && typeof global.fetch === 'function';
    if (wantServer) {
      try {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), 12000) : null;
        const res = await global.fetch('/api/ai/decompose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctl ? ctl.signal : undefined,
          body: JSON.stringify({
            title: String(task.title || '').slice(0, 400),
            description: String(task.description || '').slice(0, 4000),
            dueDate: /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate || '') ? task.dueDate : null,
            seed: Number(o.seed) || 0,
          }),
        });
        if (timer) clearTimeout(timer);
        if (res && res.ok) {
          const j = await res.json();
          const p = sanitizePlan(j);
          if (p) {
            p.engine = (typeof j.engine === 'string' && j.engine) ? j.engine : 'server planner';
            p.model = (typeof j.model === 'string' && j.model) ? j.model.slice(0, 60) : '';
            return p;
          }
        }
      } catch (_) { /* offline / standalone / aborted → built-in below */ }
    }
    return local();
  }

  global.ZTAI = {
    plan,
    decompose,
    sanitizePlan,
    sanitizeStep,
    looksLarge,
    fmtEst,
    PRIORITIES,
    MAX_STEPS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
