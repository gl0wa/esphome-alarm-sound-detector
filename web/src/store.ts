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

// ---- minimal IndexedDB persistence (recordings + labels, no audio leaves device) ----
const DB = "preset-studio", STORE = "sessions";

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveSession(s: State): Promise<void> {
  const db = await openDb();
  const payload = {
    recordings: s.recordings.map((r) => ({ id: r.id, name: r.name, pcm: r.pcm.buffer.slice(0) as ArrayBuffer })),
    examples: s.examples,
    band: s.band, duration: s.duration, repeating: s.repeating,
    params: s.params, meta: s.meta,
  };
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(payload, "current");
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

export async function loadSession(s: State): Promise<string> {
  const db = await openDb();
  const payload = await new Promise<unknown>((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const q = tx.objectStore(STORE).get("current");
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  db.close();
  if (!payload) return "Nothing saved yet.";
  const p = payload as {
    recordings: { id: string; name: string; pcm: ArrayBuffer }[];
    examples: Example[]; band: Band; duration: number; repeating: boolean;
    params: DetParams; meta: State["meta"];
  };
  s.recordings = p.recordings.map((r) => ({ id: r.id, name: r.name, pcm: new Int16Array(r.pcm) }));
  s.examples = p.examples ?? [];
  s.candidates = [];
  s.band = p.band; s.duration = p.duration; s.repeating = p.repeating;
  s.params = p.params; s.meta = p.meta;
  s.template = null; s.tmplMean = null; s.evals = []; s.margin = null;
  return `Restored ${s.recordings.length} recording(s), ${s.examples.length} example(s). Re-check the Build step (template is rebuilt, not stored).`;
}

export async function clearSession(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((res) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete("current");
    tx.oncomplete = () => res();
  });
  db.close();
}
