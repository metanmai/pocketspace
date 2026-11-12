import { compress, MediaError } from './compress.mjs';
import { bindArchive } from './archive-ui.mjs';
import { contentId, uniqueName, zipFiles, zipLimit } from './archive.mjs';

const $ = id => document.getElementById(id);
const files = [];
const updateArchive = bindArchive(() => files);
const labels = { detail: 'More detail', balanced: 'Balanced', small: 'Smallest files' };
const zipLabels = { detail: 'Fast', balanced: 'Balanced', small: 'Maximum compression' };
const imageExtensions = /\.(jpe?g|png|apng|webp|heic|heif|avif|bmp|gif)$/i;
const videoExtensions = /\.(mp4|mov|webm|m4v|mkv|avi|3gp|mpeg|mpg)$/i;
let running = false;
let previewItem;
let previewVersion;
let zipUrl;
let zipController;
let replacing = false;
const fileBridge = window.pocketspaceHost === 'windows'
  && typeof window.chrome?.webview?.postMessageWithAdditionalObjects === 'function'
  ? window.chrome.webview : undefined;

function icon(name) {
  return `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
}

function bytes(size) {
  if (size < 1000) return `${size} B`;
  if (size < 1e6) return `${(size / 1000).toFixed(size < 10000 ? 1 : 0)} KB`;
  return `${(size / 1e6).toFixed(size < 1e7 ? 2 : 1)} MB`;
}

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function iconAction(tag, symbol, title, item) {
  const action = document.createElement(tag);
  action.className = 'icon-button';
  if (tag === 'button') action.type = 'button';
  action.title = title;
  action.setAttribute('aria-label', `${title} ${item.file.name}`);
  action.innerHTML = icon(symbol);
  return action;
}

function rowFor(item) {
  const row = document.createElement('li');
  row.className = 'result';
  row.innerHTML = `<div class="thumb">${icon({ photo: 'image', video: 'video', zip: 'folder' }[item.kind])}</div>
    <div><strong class="file-name"></strong><div class="file-state"></div><progress class="encoding-progress" max="100" hidden></progress></div>
    <div class="row-actions"></div>`;
  const name = row.querySelector('.file-name');
  name.textContent = item.file.name;
  name.title = item.file.name;
  const actions = row.querySelector('.row-actions');
  const view = iconAction('button', 'sliders', 'Tune and preview', item);
  view.classList.add('tune-file');
  view.insertAdjacentHTML('beforeend', '<span>Tune</span>');
  view.setAttribute('aria-haspopup', 'dialog');
  view.hidden = true;
  view.addEventListener('click', () => openPreview(item));
  const save = iconAction('a', 'download', 'Save copy of', item);
  save.hidden = true;
  const remove = iconAction('button', 'close', 'Remove', item);
  remove.classList.add('remove');
  remove.addEventListener('click', () => { if (!replacing) removeItem(item); });
  actions.append(view, save, remove);
  $('results').append(row);
  return { row, state: row.querySelector('.file-state'), progress: row.querySelector('progress'), view, save, remove };
}

function showState(item, message, error = false) {
  item.message = message;
  item.ui.state.classList.toggle('error', error);
  item.ui.state.textContent = `${bytes(item.file.size)} · ${message}`;
}

function settingsLabel(item) {
  const { mode, profile, target } = item.settings;
  if (mode === 'zip') return `Lossless ZIP · ${zipLabels[profile]}`;
  return mode === 'preset' ? labels[profile] : `Target ${bytes(target)}`;
}

function extension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

function matchingFiles(item) {
  const suffix = extension(item.file.name);
  return suffix ? files.filter(candidate => !candidate.ui.view.hidden && extension(candidate.file.name) === suffix) : [item];
}

function canReplace(item) {
  if (!fileBridge || !item.result || item.result.extension === 'zip') return false;
  const suffix = extension(item.file.name);
  return item.result.extension === (suffix === 'jpeg' ? 'jpg' : suffix);
}

function syncPreview(item) {
  if (previewItem !== item || !$('preview').open) return;
  const busy = item.pending || !item.ui.progress.hidden;
  const { result } = item;
  $('preview-stats').textContent = `${bytes(item.file.size)} original${result ? ` → ${bytes(result.blob.size)} compressed` : ''}`;
  const status = $('preview-status');
  if (status.textContent !== item.message) status.textContent = item.message;
  const progress = $('preview-progress');
  progress.hidden = !busy;
  const value = item.ui.progress.getAttribute('value');
  if (value === null) progress.removeAttribute('value');
  else progress.value = Number(value);
  $('apply-compression').disabled = busy || replacing;
  document.querySelector('[data-version="compressed"]').disabled = !result;
  $('preview-save').hidden = !result;
  if (result) {
    $('preview-save').href = item.outputUrl;
    $('preview-save').download = result.name;
  } else {
    $('preview-save').removeAttribute('href');
  }
}

function updateSummary() {
  const ready = files.filter(item => item.result);
  const total = ready.reduce((sum, item) => sum + item.file.size - item.result.blob.size, 0);
  $('file-count').textContent = files.length;
  $('file-count').hidden = $('clear').hidden = !files.length;
  $('empty').hidden = Boolean(files.length);
  $('result-summary').hidden = !total;
  $('total-saved').textContent = `${bytes(total)} potential space savings`;
  $('download-all').hidden = ready.length < 2 || Boolean(zipUrl);
  $('replace-originals').hidden = !ready.some(canReplace);
  $('replace-originals').disabled = replacing || files.some(item => item.pending || !item.ui.progress.hidden);
  $('browse').disabled = $('clear').disabled = replacing;
  for (const { ui } of files) ui.remove.disabled = ui.view.disabled = replacing;
  updateArchive();
}

function invalidateZip() {
  zipController?.abort();
  if (zipUrl) URL.revokeObjectURL(zipUrl);
  zipUrl = undefined;
  $('zip-link')?.remove();
  $('download-all').textContent = '';
  $('download-all').insertAdjacentHTML('afterbegin', `${icon('download')} Save all as ZIP`);
}

function addFiles(selection) {
  if (replacing) return;
  $('replacement-status').hidden = true;
  const selectedProfile = document.querySelector('input[name="profile"]:checked').value;
  for (const file of selection) {
    let kind = 'zip';
    if (file.type.startsWith('image/') || imageExtensions.test(file.name)) kind = 'photo';
    if (file.type.startsWith('video/') || videoExtensions.test(file.name)) kind = 'video';
    const item = {
      file, kind, settings: { mode: kind === 'zip' ? 'zip' : 'preset', profile: selectedProfile },
      controller: new AbortController(), pending: false,
    };
    item.ui = rowFor(item);
    files.push(item);
    if (!file.size) {
      showState(item, 'Empty file.', true);
    } else {
      item.ui.view.hidden = false;
      item.pending = true;
      showState(item, `Queued · ${settingsLabel(item)}`);
    }
  }
  notice('');
  updateSummary();
  void runQueue();
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    for (let item = files.find(candidate => candidate.pending); item; item = files.find(candidate => candidate.pending)) {
      item.pending = false;
      const { signal } = item.controller;
      const { state, progress, save } = item.ui;
      const { mode, profile, target } = item.settings;
      showState(item, `Compressing… · ${settingsLabel(item)}`);
      progress.removeAttribute('value');
      progress.hidden = false;
      syncPreview(item);
      updateArchive();
      progress.setAttribute('aria-label', `Compressing ${item.file.name}`);
      try {
        const result = await compress(item.file, mode === 'zip' ? 'zip' : item.kind, profile, signal, (fraction, attempt) => {
          if (signal.aborted) return;
          const percent = Math.min(99, Math.floor(fraction * 100));
          if (percent > 0) progress.value = percent;
          else progress.removeAttribute('value');
          const phase = attempt > 1 ? `Refining (pass ${attempt})…` : 'Compressing…';
          item.ui.state.textContent = `${bytes(item.file.size)} · ${phase}${percent > 0 ? ` ${percent}%` : ''}`;
          item.message = phase;
          syncPreview(item);
        }, target);
        if (result) {
          item.result = result;
          item.outputUrl = URL.createObjectURL(result.blob);
          save.href = item.outputUrl;
          save.download = result.name;
          save.hidden = false;
          const percent = (1 - result.blob.size / item.file.size) * 100;
          const saving = percent < 1 ? '<1%' : percent >= 99.5 ? '>99%' : `${Math.round(percent)}%`;
          state.innerHTML = `${bytes(item.file.size)} ${icon('arrow')} ${bytes(result.blob.size)} <span class="saving"></span>`;
          state.querySelector('.saving').textContent = `${saving} smaller`;
          state.title = settingsLabel(item);
          item.message = target && result.blob.size > target
            ? `Target ${bytes(target)} missed. This is the smallest copy produced (${saving} smaller).`
            : target ? `Target ${bytes(target)} reached · ${saving} smaller` : `${settingsLabel(item)} · ${saving} smaller`;
          if (target && result.blob.size > target) {
            const warning = document.createElement('small');
            warning.className = 'target-warning';
            warning.textContent = `Over ${bytes(target)} target`;
            state.append(warning);
          }
          if (result.blob.type.startsWith('image/')) {
            const thumb = document.createElement('img');
            thumb.className = 'thumb';
            thumb.alt = '';
            thumb.src = item.outputUrl;
            item.ui.row.querySelector('.thumb').replaceWith(thumb);
          }
          $('live-status').textContent = `${item.file.name} compressed, ${saving} smaller.`;
          invalidateZip();
        } else {
          showState(item, target ? `Couldn’t reach ${bytes(target)} or produce a smaller copy.`
            : mode === 'zip' ? 'A lossless ZIP would not be smaller.' : 'Already compact. No smaller copy.');
          $('live-status').textContent = `${item.file.name}. ${item.message}`;
        }
      } catch (error) {
        if (!signal.aborted) {
          showState(item, error instanceof MediaError ? error.message : 'Couldn’t read or compress this file.', true);
          $('live-status').textContent = `${item.file.name} could not be compressed.`;
        }
      } finally {
        progress.hidden = true;
        progress.removeAttribute('value');
        syncPreview(item);
        if (item.result && previewItem === item && $('preview').open) showVersion('compressed');
        updateSummary();
      }
    }
  } finally {
    running = false;
  }
}

function removeItem(item) {
  if (previewItem === item) $('preview').close();
  item.controller.abort();
  if (item.result) invalidateZip();
  clearOutput(item);
  if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
  item.ui.row.remove();
  files.splice(files.indexOf(item), 1);
  updateSummary();
}

function openPreview(item) {
  previewItem = item;
  item.originalUrl ??= URL.createObjectURL(item.file);
  $('preview-title').textContent = item.file.name;
  const { mode, profile, amount, unit } = item.settings;
  $('compression-mode').value = mode;
  $('file-preset').value = profile;
  $('file-percent').value = mode === 'percent' ? amount : 50;
  $('file-size').value = mode === 'size' ? amount : Math.floor(item.file.size / 2) / 1000;
  $('file-unit').value = mode === 'size' ? unit : 1000;
  $('file-size').setCustomValidity('');
  $('apply-extension').checked = false;
  const matches = matchingFiles(item).length;
  $('batch-scope').hidden = matches < 2;
  $('batch-label').textContent = `Apply to all ${matches} .${extension(item.file.name)} files`;
  $('batch-status').hidden = true;
  updateSettingsFields();
  $('preview').showModal();
  syncPreview(item);
  showVersion(item.result ? 'compressed' : 'original');
}

function updateSettingsFields() {
  const mode = $('compression-mode').value;
  for (const option of $('compression-mode').options) {
    option.disabled = previewItem.kind === 'zip' && option.value !== 'zip';
  }
  const presetLabels = mode === 'zip' ? zipLabels : labels;
  for (const option of $('file-preset').options) option.textContent = presetLabels[option.value];
  $('preset-field').hidden = mode !== 'preset' && mode !== 'zip';
  $('percent-field').hidden = $('file-percent').disabled = mode !== 'percent';
  $('size-field').hidden = $('file-size').disabled = mode !== 'size';
}

$('compression-mode').addEventListener('change', updateSettingsFields);
for (const id of ['file-size', 'file-unit']) {
  $(id).addEventListener('input', () => $('file-size').setCustomValidity(''));
}

function clearOutput(item) {
  if (item.outputUrl) {
    URL.revokeObjectURL(item.outputUrl);
    item.outputUrl = undefined;
    void item.result.dispose?.();
    item.result = undefined;
    item.ui.save.hidden = true;
    item.ui.save.removeAttribute('href');
    if (item.kind === 'photo') item.ui.row.querySelector('.thumb').outerHTML = `<div class="thumb">${icon('image')}</div>`;
  }
}

function queueSettings(item, settings) {
  item.controller.abort();
  item.settings = settings;
  item.controller = new AbortController();
  item.pending = true;
  clearOutput(item);
  item.ui.state.removeAttribute('title');
  showState(item, `Queued · ${settingsLabel(item)}`);
}

$('compression-settings').addEventListener('submit', event => {
  event.preventDefault();
  const item = previewItem;
  if (!item || item.pending || !item.ui.progress.hidden || replacing) return;
  const mode = $('compression-mode').value;
  const profile = mode === 'preset' || mode === 'zip' ? $('file-preset').value : 'detail';
  const unit = Number($('file-unit').value);
  const amount = mode === 'percent' ? $('file-percent').valueAsNumber : $('file-size').valueAsNumber;
  const size = Math.floor(amount * unit);
  if (mode === 'size' && (size < 1 || size >= item.file.size)) {
    $('file-size').setCustomValidity('Enter a target size smaller than the original.');
    $('file-size').reportValidity();
    return;
  }
  const scope = $('apply-extension').checked ? matchingFiles(item) : [item];
  const eligible = scope.filter(candidate => (mode === 'zip' || candidate.kind !== 'zip')
    && (mode !== 'size' || candidate.file.size > size));
  if (previewVersion === 'compressed') showVersion('original');
  if (eligible.some(candidate => candidate.result)) invalidateZip();
  for (const candidate of eligible) {
    const target = mode === 'percent' ? Math.max(1, Math.floor(candidate.file.size * (100 - amount) / 100))
      : mode === 'size' ? size : undefined;
    queueSettings(candidate, { mode, profile, amount, unit, target });
  }
  const batch = $('batch-status');
  const skipped = scope.length - eligible.length;
  batch.hidden = scope.length < 2;
  batch.textContent = `Queued ${eligible.length} of ${scope.length} matching files.${skipped ? ' Skipped files already within the size cap or incompatible with this mode.' : ''}`;
  syncPreview(item);
  updateSummary();
  void runQueue();
});

function showVersion(version) {
  if (!previewItem || (version === 'compressed' && !previewItem.result)) return;
  previewVersion = version;
  const container = $('preview-media');
  const original = version === 'original';
  const isVideo = previewItem.kind === 'video';
  const previous = container.querySelector('video');
  const seek = previous?.currentTime ?? 0;
  previous?.pause();
  if (previewItem.kind === 'zip' || (!original && previewItem.result.extension === 'zip')) {
    const message = document.createElement('p');
    message.textContent = original
      ? 'Lossless compression preserves the contents of this file.'
      : 'Open the ZIP to extract the original file.';
    container.replaceChildren(message);
  } else {
    const media = document.createElement(isVideo ? 'video' : 'img');
    if (isVideo) {
      media.controls = media.playsInline = true;
      media.preload = 'metadata';
      media.addEventListener('loadedmetadata', () => { media.currentTime = Math.min(seek, media.duration); });
    } else {
      media.alt = `${original ? 'Original' : 'Compressed'} photo preview`;
    }
    media.addEventListener('error', () => {
      if (container.firstElementChild !== media) return;
      const fallback = document.createElement('p');
      fallback.textContent = 'This browser can’t preview this file.';
      container.replaceChildren(fallback);
    });
    media.src = original ? previewItem.originalUrl : previewItem.outputUrl;
    container.replaceChildren(media);
  }
  document.querySelectorAll('[data-version]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.version === version));
  });
}

function replacementReply(id, action, fields = {}, attachments) {
  return new Promise((resolve, reject) => {
    const receive = ({ data }) => {
      if (data?.id !== id) return;
      clearTimeout(timer);
      fileBridge.removeEventListener('message', receive);
      if (data.state === 'error') reject(new Error(data.message));
      else resolve(data);
    };
    const timer = action === 'replace-chunk' ? setTimeout(() => {
      fileBridge.removeEventListener('message', receive);
      reject(new Error('Pocketspace stopped receiving file data.'));
    }, 30000) : undefined;
    fileBridge.addEventListener('message', receive);
    try {
      const message = { ...fields, id, action };
      if (attachments) fileBridge.postMessageWithAdditionalObjects(message, attachments);
      else fileBridge.postMessage(message);
    } catch (error) {
      clearTimeout(timer);
      fileBridge.removeEventListener('message', receive);
      reject(error);
    }
  });
}

function base64(bytes) {
  if (bytes.toBase64) return bytes.toBase64();
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return btoa(binary);
}

async function replaceFile(item, id) {
  const { blob } = item.result;
  const controller = new AbortController();
  try {
    const originalHash = await contentId(item.file, controller.signal);
    const outputHash = await contentId(blob, controller.signal);
    const ready = await replacementReply(id, 'replace-start', { originalHash, outputHash });
    if (ready.state !== 'ready') throw new Error('Windows didn’t prepare the replacement.');
    const chunkBytes = 1024 * 1024;
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      const chunk = new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer());
      const reply = await replacementReply(id, 'replace-chunk', { data: base64(chunk) });
      if (reply.state !== 'chunk') throw new Error('Windows didn’t receive the compressed file.');
    }
    const reply = await replacementReply(id, 'replace-finish');
    if (reply.state !== 'done') throw new Error('Windows didn’t complete the replacement.');
    removeItem(item);
  } catch (error) {
    try { fileBridge.postMessage({ id, action: 'replace-cancel' }); } catch {}
    throw error;
  }
}

$('replace-originals').addEventListener('click', async () => {
  const button = $('replace-originals');
  const candidates = files.filter(canReplace);
  if (button.disabled || !candidates.length) return;
  const total = files.length;
  const id = crypto.randomUUID();
  const entries = candidates.map(item => ({
    id: crypto.randomUUID(), name: item.file.name, extension: item.result.extension,
    originalSize: item.file.size, outputSize: item.result.blob.size,
  }));
  const status = $('replacement-status');
  replacing = true;
  status.hidden = false;
  status.textContent = 'Confirm replacement in Windows.';
  updateSummary();
  try {
    const reply = await replacementReply(id, 'replace-batch', { files: entries }, candidates.map(item => item.file));
    if (reply.state === 'cancelled') {
      status.textContent = 'Replacement cancelled.';
      return;
    }
    if (reply.state !== 'approved') throw new Error('Windows didn’t approve the batch.');
    const ids = new Set(reply.approvedIds);
    const selected = entries.map((entry, index) => ({ entry, item: candidates[index] }))
      .filter(({ entry }) => ids.has(entry.id));
    const failures = [];
    for (const [index, { entry, item }] of selected.entries()) {
      status.textContent = `Replacing ${index + 1} of ${selected.length} · ${item.file.name}`;
      try {
        await replaceFile(item, entry.id);
      } catch (error) {
        failures.push(`${item.file.name} (${error.message})`);
      }
    }
    const skipped = total - selected.length;
    status.textContent = `Replaced ${selected.length - failures.length} of ${total} originals.`
      + (skipped ? ` Skipped ${skipped} without an eligible same-format copy.` : '')
      + (failures.length ? ` Couldn’t replace ${failures.join(', ')}.` : '');
  } catch (error) {
    status.textContent = error.message || 'Couldn’t replace the originals.';
  } finally {
    try { fileBridge.postMessage({ id, action: 'replace-batch-end' }); } catch {}
    replacing = false;
    updateSummary();
  }
});

$('browse').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => {
  addFiles(event.currentTarget.files);
  event.currentTarget.value = '';
});

const dropzone = $('dropzone');
let dragDepth = 0;
dropzone.addEventListener('dragenter', event => {
  event.preventDefault();
  dragDepth++;
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragover', event => event.preventDefault());
dropzone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove('dragging');
});
dropzone.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('dragging');
  addFiles(event.dataTransfer.files);
});
window.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
window.addEventListener('drop', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});

$('clear').addEventListener('click', () => {
  if (replacing) return;
  $('replacement-status').hidden = true;
  for (const item of [...files]) removeItem(item);
  notice('');
  $('browse').focus();
});
document.querySelectorAll('[data-version]').forEach(button => {
  button.addEventListener('click', () => showVersion(button.dataset.version));
});
$('preview').addEventListener('close', () => {
  if ($('preview').open) return;
  $('preview-media').querySelector('video')?.pause();
  $('preview-media').replaceChildren();
  previewItem = undefined;
});

$('download-all').addEventListener('click', async () => {
  const button = $('download-all');
  const ready = files.filter(item => item.result);
  zipController = new AbortController();
  const { signal } = zipController;
  button.disabled = true;
  button.textContent = 'Preparing ZIP…';
  try {
    if (ready.reduce((sum, item) => sum + item.result.blob.size, 0) > zipLimit) {
      throw new MediaError('This batch is too large for one ZIP. Save the copies individually.');
    }
    const names = new Set();
    const entries = ready.map(({ result }) => ({ name: uniqueName(result.name, names), blob: result.blob }));
    const archive = await zipFiles(entries, signal);
    signal.throwIfAborted();
    zipUrl = URL.createObjectURL(archive);
    const link = document.createElement('a');
    link.id = 'zip-link';
    link.className = 'button accent';
    link.href = zipUrl;
    link.download = 'Pocketspace-compressed.zip';
    link.innerHTML = `${icon('download')} Download ZIP`;
    button.after(link);
    button.hidden = true;
    link.focus();
  } catch (error) {
    if (!signal.aborted) {
      notice(error instanceof MediaError ? error.message : 'Couldn’t prepare the ZIP. You can still save copies individually.');
    }
  } finally {
    zipController = undefined;
    button.disabled = false;
    button.innerHTML = `${icon('download')} Save all as ZIP`;
  }
});
