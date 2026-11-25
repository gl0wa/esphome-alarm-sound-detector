// App state + IndexedDB session persistence.
import { Band, BuiltTemplate, DEFAULT_BAND, DetParams, DEFAULT_PARAMS } from "./const";

export interface Recording {
  id: string;
  name: string;
  pcm: Int16Array;
}

export interface Example {
  id: string;
  recId: string;
  t0: number;
  t1: number;
}

export interface Candidate extends Example {
  score: number;
  status: "pending" | "accepted" | "rejected";
  /** Example created when this candidate was accepted (removed again on undo/reject). */
  exampleId?: string;
}

export interface EvalRec {
  recId: string;
  scores: Float32Array;
  firstFrame: number;
  events: { type: string; t: number; score: number }[];
  maxNeg: number;
}

export interface State {
  recordings: Recording[];
  examples: Example[];
  candidates: Candidate[];
  band: Band;
  duration: number;
  repeating: boolean;
  template: BuiltTemplate | null;
  tmplMean: Float32Array | null;
  params: DetParams;
  margin: { minPos: number; maxNeg: number; margin: number } | null;
  evals: EvalRec[];
  confuserId: string;
  meta: {
    id: string; name: string; manufacturer: string; model: string; sound: string;
    description: string; aliases: string; testedAgainst: string; validation: string; notes: string;
  };
}

let n = 0;
export const uid = () => `x${Date.now().toString(36)}${(n++).toString(36)}`;

export function freshState(): State {
  return {
    recordings: [], examples: [], candidates: [],
    band: { ...DEFAULT_BAND }, duration: 1.3, repeating: true,
    template: null, tmplMean: null,
    params: { ...DEFAULT_PARAMS },
    margin: null, evals: [], confuserId: "",
    meta: {
      id: "", name: "", manufacturer: "", model: "", sound: "",
      description: "", aliases: "", testedAgainst: "", validation: "", notes: "",
    },
  };
}

// ---- IndexedDB persistence (stays in this browser; nothing is uploaded) ----
// Keys in one object store: "meta" = labels/settings/template (small, rewritten on
// every change), "rec:<id>" = one recording's PCM (written once). "current" is the
// legacy single-blob format from earlier versions, still readable.
const DB = "preset-studio", STORE = "sessions";
const SESSION_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error("transaction aborted"));
  });
}

interface SavedMeta {
  version: number;
  savedAt: number;
  recordings: { id: string; name: string; samples: number }[];
  examples: Example[];
  candidates: Candidate[];
  band: Band; duration: number; repeating: boolean;
  template: { q: ArrayBuffer; frames: number; bins: number } | null;
  tmplMean: ArrayBuffer | null;
  params: DetParams;
  margin: State["margin"];
  confuserId: string;
  meta: State["meta"];
}

export interface SessionSummary { savedAt: number; recordings: number; examples: number; hasTemplate: boolean }


/** Save everything. Recordings are written once; labels and settings every time. */
export async function saveSession(s: State): Promise<void> {
  const db = await openDb();
  try {
    const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
    const existing = new Set((await req(store("readonly").getAllKeys())).map(String));
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    for (const r of s.recordings) {
      const key = `rec:${r.id}`;
      if (!existing.has(key)) os.put(r.pcm.slice().buffer, key); // audio is written once; copy avoids storing a shared buffer
    }
    const keep = new Set(s.recordings.map((r) => `rec:${r.id}`));
    for (const k of existing) if (k.startsWith("rec:") && !keep.has(k)) os.delete(k);
    if (existing.has("current")) os.delete("current"); // migrate away from the legacy blob
    const meta: SavedMeta = {
      version: SESSION_VERSION, savedAt: Date.now(),
      recordings: s.recordings.map((r) => ({ id: r.id, name: r.name, samples: r.pcm.length })),
      examples: s.examples, candidates: s.candidates,
      band: s.band, duration: s.duration, repeating: s.repeating,
      template: s.template ? { q: s.template.q.slice().buffer, frames: s.template.frames, bins: s.template.bins } : null,
      tmplMean: s.tmplMean ? s.tmplMean.slice().buffer : null,
      params: s.params, margin: s.margin, confuserId: s.confuserId, meta: s.meta,
    };
    os.put(meta, "meta");
    await done(tx);
  } finally {
    db.close();
  }
}

/** What is saved, without loading the audio. null = nothing saved. */
export async function peekSession(): Promise<SessionSummary | null> {
  const db = await openDb();
  try {
    const os = db.transaction(STORE, "readonly").objectStore(STORE);
    const meta = (await req(os.get("meta"))) as SavedMeta | undefined;
    if (meta) return { savedAt: meta.savedAt, recordings: meta.recordings.length, examples: meta.examples.length, hasTemplate: !!meta.template };
    const legacy = (await req(os.get("current"))) as { recordings: unknown[]; examples: unknown[] } | undefined;
    if (legacy) return { savedAt: 0, recordings: legacy.recordings.length, examples: legacy.examples?.length ?? 0, hasTemplate: false };
    return null;
  } finally {
    db.close();
  }
}

export async function loadSession(s: State): Promise<string> {
  const db = await openDb();
  try {
    const os = db.transaction(STORE, "readonly").objectStore(STORE);
    const meta = (await req(os.get("meta"))) as SavedMeta | undefined;
    if (!meta) {
      const legacy = (await req(os.get("current"))) as {
        recordings: { id: string; name: string; pcm: ArrayBuffer }[];
        examples: Example[]; band: Band; duration: number; repeating: boolean; params: DetParams; meta: State["meta"];
      } | undefined;
      if (!legacy) return "Nothing saved yet.";
      Object.assign(s, freshState());
      s.recordings = legacy.recordings.map((r) => ({ id: r.id, name: r.name, pcm: new Int16Array(r.pcm) }));
      s.examples = legacy.examples ?? [];
      s.band = legacy.band; s.duration = legacy.duration; s.repeating = legacy.repeating;
      s.params = legacy.params; s.meta = legacy.meta;
      return `Restored ${s.recordings.length} recording(s) and ${s.examples.length} example(s).`;
    }
    const recs: Recording[] = [];
    const missing: string[] = [];
    for (const r of meta.recordings) {
      const buf = (await req(os.get(`rec:${r.id}`))) as ArrayBuffer | undefined;
      if (buf) recs.push({ id: r.id, name: r.name, pcm: new Int16Array(buf) });
      else missing.push(r.name);
    }
    const ids = new Set(recs.map((r) => r.id));
    Object.assign(s, freshState());
    s.recordings = recs;
    s.examples = meta.examples.filter((e) => ids.has(e.recId));
    s.candidates = (meta.candidates ?? []).filter((c) => ids.has(c.recId));
    s.band = meta.band; s.duration = meta.duration; s.repeating = meta.repeating;
    s.template = meta.template ? { q: new Int8Array(meta.template.q), frames: meta.template.frames, bins: meta.template.bins } : null;
    s.tmplMean = meta.tmplMean ? new Float32Array(meta.tmplMean) : null;
    s.params = meta.params; s.margin = meta.margin; s.confuserId = meta.confuserId ?? ""; s.meta = meta.meta;
    return `Restored ${s.recordings.length} recording(s), ${s.examples.length} example(s), ` +
      `${s.candidates.length} candidate(s)${s.template ? " and the built template" : ""}.` +
      (missing.length ? ` Missing audio for: ${missing.join(", ")}.` : "");
  } finally {
    db.close();
  }
}

export async function clearSession(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  } finally {
    db.close();
  }
}

/** Approximate browser storage used by this site, for display. */
export async function storageUsed(): Promise<string> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (e?.usage === undefined) return "";
    return `${(e.usage / 1e6).toFixed(1)} MB`;
  } catch { return ""; }
}
