// طبقة قاعدة البيانات: Firebase Authentication + Cloud Firestore
// تُعرّض الدوال على window.StudentDB ليستخدمها السكربت الرئيسي في index.html
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
    getFirestore, collection, doc, onSnapshot, runTransaction,
    writeBatch, updateDoc, deleteDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const COLLECTION = 'students';
const BATCH_LIMIT = 400; // Firestore allows 500 writes per batch
const STUDENT_FIELDS = ['name', 'department', 'stage', 'studyType', 'totalTuition',
    'p1', 'r1', 'p2', 'r2', 'p3', 'r3', 'p4', 'r4'];

const isConfigured = !Object.values(firebaseConfig).some(v => String(v).includes('PASTE_'));

let auth = null, db = null;
if (isConfigured) {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
}

export class DuplicateError extends Error {
    constructor(name) {
        super(`الطالب "${name}" مسجل مسبقاً في نفس القسم والمرحلة`);
        this.code = 'duplicate';
    }
}

// Normalize Arabic text so spelling variants of the same name compare equal
// (diacritics, tatweel, alef/hamza forms, ى/ي, ة/ه, Persian ی/ک, extra spaces).
export function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/[ً-ٰٟـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/[ىی]/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/ک/g, 'ك')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export function dupKeyOf(s) {
    return [s.name, s.department, s.stage].map(normalizeText).join('|');
}

// The document ID is a hash of the duplicate key, so the same student can only ever
// occupy one document — Firestore itself rejects a second one.
async function docIdFor(s) {
    const bytes = new TextEncoder().encode(dupKeyOf(s));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanStudent(s) {
    const out = {};
    STUDENT_FIELDS.forEach(f => {
        const isNumber = f === 'totalTuition' || /^p\d$/.test(f);
        out[f] = isNumber ? (Number(s[f]) || 0) : String(s[f] ?? '').trim();
    });
    out.dupKey = dupKeyOf(out);
    return out;
}

function requireDb() {
    if (!db) throw new Error('لم يتم إعداد Firebase بعد. يرجى تعبئة ملف firebase-config.js');
}

function onAuth(callback) {
    if (!auth) { callback(null); return () => {}; }
    return onAuthStateChanged(auth, callback);
}

function login(email, password) {
    requireDb();
    return signInWithEmailAndPassword(auth, email, password);
}

function logout() {
    return auth ? signOut(auth) : Promise.resolve();
}

// Live listener: calls onData with the full, sorted list on every change in the database.
function subscribe(onData, onError) {
    requireDb();
    return onSnapshot(collection(db, COLLECTION), snap => {
        const list = snap.docs.map(d => {
            const data = d.data({ serverTimestamps: 'estimate' });
            return { ...data, docId: d.id, _created: data.createdAt ? data.createdAt.toMillis() : 0 };
        });
        list.sort((a, b) => a._created - b._created);
        onData(list);
    }, onError);
}

async function addStudent(student) {
    requireDb();
    const data = cleanStudent(student);
    const ref = doc(db, COLLECTION, await docIdFor(data));
    await runTransaction(db, async tx => {
        const existing = await tx.get(ref);
        if (existing.exists()) throw new DuplicateError(data.name);
        tx.set(ref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    return ref.id;
}

async function updateStudent(oldId, student) {
    requireDb();
    const data = cleanStudent(student);
    const newId = await docIdFor(data);
    const oldRef = doc(db, COLLECTION, oldId);

    if (newId === oldId) {
        await updateDoc(oldRef, { ...data, updatedAt: serverTimestamp() });
        return oldId;
    }

    // Name/department/stage changed: the record moves to a new ID, unless that ID is taken.
    const newRef = doc(db, COLLECTION, newId);
    await runTransaction(db, async tx => {
        const [target, current] = await Promise.all([tx.get(newRef), tx.get(oldRef)]);
        if (target.exists()) throw new DuplicateError(data.name);
        const createdAt = current.exists() && current.data().createdAt ? current.data().createdAt : serverTimestamp();
        tx.set(newRef, { ...data, createdAt, updatedAt: serverTimestamp() });
        tx.delete(oldRef);
    });
    return newId;
}

async function deleteStudents(ids) {
    requireDb();
    const list = [...ids];
    for (let i = 0; i < list.length; i += BATCH_LIMIT) {
        const batch = writeBatch(db);
        list.slice(i, i + BATCH_LIMIT).forEach(id => batch.delete(doc(db, COLLECTION, id)));
        await batch.commit();
    }
}

function deleteStudent(id) {
    requireDb();
    return deleteDoc(doc(db, COLLECTION, id));
}

// Bulk insert (Excel import). Skips rows that duplicate each other or an existing record.
// existingIds: IDs already loaded from the live listener, used to skip known duplicates
// without a round trip. Rules reject any overwrite, so a record added by someone else
// mid-import fails its batch, which is then retried row by row.
async function importStudents(rows, existingIds = new Set()) {
    requireDb();
    const result = { added: 0, duplicates: [], failed: [] };
    const seen = new Set(existingIds);
    const pending = [];

    for (const row of rows) {
        const data = cleanStudent(row);
        if (!data.name) continue;
        const id = await docIdFor(data);
        if (seen.has(id)) { result.duplicates.push(data.name); continue; }
        seen.add(id);
        pending.push({ id, data });
    }

    for (let i = 0; i < pending.length; i += BATCH_LIMIT) {
        const chunk = pending.slice(i, i + BATCH_LIMIT);
        const batch = writeBatch(db);
        chunk.forEach(({ id, data }) => batch.set(doc(db, COLLECTION, id),
            { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
        try {
            await batch.commit();
            result.added += chunk.length;
        } catch (batchErr) {
            for (const { data } of chunk) {
                try {
                    await addStudent(data);
                    result.added++;
                } catch (err) {
                    if (err.code === 'duplicate') result.duplicates.push(data.name);
                    else result.failed.push({ name: data.name, error: err });
                }
            }
        }
    }
    return result;
}

window.StudentDB = {
    isConfigured, onAuth, login, logout, subscribe,
    addStudent, updateStudent, deleteStudent, deleteStudents, importStudents,
    get currentUser() { return auth ? auth.currentUser : null; }
};
window.dispatchEvent(new Event('studentdb-ready'));
