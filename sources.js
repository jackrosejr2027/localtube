"use strict";
const setupSources = [];
let unrememberedSources = false;
let sourceDB;
function openSourceDB() {
  if (!sourceDB) sourceDB = new Promise((resolve, reject) => {
    const request = indexedDB.open("locatube-locations", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("locations", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser storage is unavailable."));
  });
  return sourceDB;
}
async function locationStore(action, value) {
  const db = await openSourceDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("locations", action === "get" ? "readonly" : "readwrite");
    const request = transaction.objectStore("locations")[action](value);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(new Error("Could not remember this location in browser storage."));
  });
}
async function rememberLocation(handle, separateChannels) {
  for (const source of setupSources) {
    const existing = await locationStore("get", source.id);
    if (existing && await handle.isSameEntry(existing.handle)) return;
  }
  const source = { id: crypto.randomUUID(), kind: handle.kind, name: handle.name };
  await locationStore("put", { ...source, handle, separateChannels });
  setupSources.push(source);
}
async function filesAtLocation(handle) {
  if (handle.kind === "file") return [{ file: await handle.getFile(), path: handle.name }];
  const files = [];
  const pending = [{ handle, path: handle.name + "/" }];
  while (pending.length) {
    const folder = pending.pop();
    for await (const child of folder.handle.values()) {
      if (child.kind === "directory") pending.push({ handle: child, path: folder.path + child.name + "/" });
      else if (isVideo(child)) files.push({ file: await child.getFile(), path: folder.path + child.name });
    }
  }
  return files;
}
async function addLocation(folder) {
  const picker = folder ? window.showDirectoryPicker : window.showOpenFilePicker;
  if (!picker) { (folder ? $("folder-input") : $("files-input")).click(); return; }
  try {
    const handles = folder ? [await window.showDirectoryPicker({ mode: "read" })] : await window.showOpenFilePicker({ multiple: true });
    for (const handle of handles) {
      const entries = await filesAtLocation(handle);
      if (!entries.some(entry => isVideo(entry.file))) { toast("No supported media files found."); continue; }
      const mode = folder ? await chooseFolderImport(entries) : "individual";
      if (!["folder", "individual"].includes(mode)) continue;
      if (!folder) await importFiles(entries, true);
      try { await rememberLocation(handle, mode === "individual"); }
      catch (error) { unrememberedSources = true; toast(error.message); }
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    toast(error.name === "SecurityError" ? "Reusable folder access is blocked here. Open the app directly or use the offline app in Chrome/Edge." : error.message || "Could not open this location.");
  }
}
function saveCurrentSetup() {
  if (unrememberedSources) { toast("Some files lack reusable access. Start fresh and add your locations using Add folder / Add videos in Chrome or Edge before saving."); return; }
  if (!setupSources.length) { toast("Add a folder or files before saving your setup."); return; }
  const manifest = { locations: setupSources.map(({ id, kind, name }) => ({ id, kind, name })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "locatube-setup.json";
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast("Saved your file and folder locations. Load this JSON in the same browser to reopen them.");
}
async function loadCurrentSetup(file) {
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error("Choose a setup file smaller than 1 MB.");
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.locations) || !data.locations.length || data.locations.length > 10000) throw new Error("Choose a location setup JSON. Older video-list setups need to be saved again.");
    const records = [];
    for (const source of data.locations) {
      if (!source || typeof source.id !== "string" || !["file", "directory"].includes(source.kind) || typeof source.name !== "string") throw new Error("Invalid location reference.");
      const record = await locationStore("get", source.id);
      if (!record?.handle) throw new Error("These locations aren't stored in this browser. Add them once here, then save a new setup.");
      records.push(record);
    }
    let loaded = 0, denied = 0, missing = 0;
    for (const record of records) {
      try {
        let permission = await record.handle.queryPermission({ mode: "read" });
        if (permission !== "granted") permission = await record.handle.requestPermission({ mode: "read" });
        if (permission !== "granted") { denied++; continue; }
        const entries = await filesAtLocation(record.handle);
        await importFiles(entries, record.separateChannels, true);
        if (!setupSources.some(source => source.id === record.id)) setupSources.push({ id: record.id, kind: record.kind, name: record.name });
        loaded++;
      } catch (error) { if (["SecurityError", "NotAllowedError"].includes(error.name)) denied++; else missing++; }
    }
    toast("Loaded " + loaded + " location(s)." + (denied ? " Access not granted for " + denied + "; load again and allow access." : "") + (missing ? " " + missing + " location(s) moved or unavailable." : ""));
  } catch (error) { toast(error.message || "Could not load this setup."); }
}
