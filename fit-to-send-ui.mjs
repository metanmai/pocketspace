import { fitMedia, PhotoPrivacyError, splitMedia } from './fit-to-send.mjs';
import { checkPhotoLocation, mediaUrl, mobilePlatform, revokeMediaUrl, shareMobile } from './mobile.mjs';
import { MediaError } from './compress.mjs';
import { checkWindowsPhotoLocation } from './photo-location.mjs';

export function bindFitToSend(getItems, formatBytes, saveWindowsZip) {
  const windows = window.pocketspaceHost === 'windows';
  const android = mobilePlatform === 'android';
  if (mobilePlatform && !android) return { update() {} };
  const opener = document.getElementById('open-fit-to-send');
  const dialog = document.getElementById('fit-to-send');
  const form = dialog.querySelector('#fit-form');
  const settings = dialog.querySelector('#fit-settings');
  const list = dialog.querySelector('#fit-photos');
  const limit = dialog.querySelector('#fit-limit');
  const privacy = dialog.querySelector('#fit-privacy');
  const privacyLabel = dialog.querySelector('#fit-privacy-label');
  const status = dialog.querySelector('#fit-status');
  const prepare = dialog.querySelector('#fit-prepare');
  const share = dialog.querySelector('#fit-share');
  if (windows) share.textContent = 'Save ZIP';
  if (!windows && !android) share.textContent = 'Download ZIP';
  const split = dialog.querySelector('#fit-split');
  const part = dialog.querySelector('#fit-part');
  const partPicker = dialog.querySelector('#fit-part-picker');
  const review = dialog.querySelector('#fit-review');
  const reviewFile = dialog.querySelector('#fit-review-file');
  const reviewDetails = dialog.querySelector('#fit-review-details');
  const reviewImage = dialog.querySelector('#fit-review-image');
  const reviewVideo = dialog.querySelector('#fit-review-video');
  const reviewError = dialog.querySelector('#fit-review-error');
  const reviewKeep = dialog.querySelector('#fit-review-keep');
  let media = [];
  let task;
  let outputs = [];
  let canSplit = false;
  let previewUrl;
  const downloads = new Map();
  let locationController;

  function render() {
    const ready = outputs.length > 0;
    settings.disabled = Boolean(task);
    prepare.disabled = Boolean(task);
    prepare.hidden = ready;
    split.hidden = ready || !canSplit;
    split.disabled = Boolean(task);
    share.hidden = !ready;
    share.disabled = Boolean(task);
    review.hidden = !ready;
    partPicker.hidden = outputs.length < 2;
    part.disabled = Boolean(task);
    reviewKeep.disabled = Boolean(task);
  }

  function showReview() {
    revokeMediaUrl(previewUrl);
    reviewImage.removeAttribute('src');
    if (reviewVideo.hasAttribute('src')) {
      reviewVideo.pause();
      reviewVideo.removeAttribute('src');
      reviewVideo.load();
    }
    previewUrl = undefined;
    const entry = outputs[part.selectedIndex]?.entries[reviewFile.selectedIndex];
    if (!entry) return;
    const variant = entry.blob === entry.file ? 'Original' : entry.privateCopy ? 'Location metadata removed' : 'Compressed';
    reviewDetails.textContent = `${formatBytes(entry.blob.size)} · ${variant}`;
    reviewKeep.hidden = entry.blob === entry.file;
    reviewError.hidden = true;
    reviewImage.hidden = entry.kind === 'video';
    reviewVideo.hidden = entry.kind !== 'video';
    reviewImage.alt = entry.name;
    previewUrl = mediaUrl(entry.blob);
    const preview = entry.kind === 'video' ? reviewVideo : reviewImage;
    preview.src = previewUrl;
  }

  function reset() {
    for (const url of downloads.values()) revokeMediaUrl(url);
    downloads.clear();
    for (const output of outputs) void output.dispose?.();
    outputs = [];
    canSplit = false;
    part.replaceChildren();
    reviewFile.replaceChildren();
    showReview();
    status.textContent = '';
    render();
  }

  async function run(action, fallback) {
    if (task) return;
    const controller = new AbortController();
    const { signal } = controller;
    task = controller;
    render();
    try {
      await action(signal);
    } catch (error) {
      if (!signal.aborted && error.name !== 'AbortError') {
        status.textContent = error instanceof MediaError || error instanceof PhotoPrivacyError ? error.message : fallback;
      }
    } finally {
      if (task === controller) {
        task = undefined;
        render();
      }
    }
  }

  async function inspectOriginal(item) {
    const { file, kind, checkbox, warning } = item;
    if (kind !== 'photo' || !checkbox.checked) {
      warning.hidden = true;
      return;
    }
    const { signal } = locationController;
    if (!item.location) {
      warning.textContent = 'Checking for location metadata…';
      warning.hidden = false;
      const check = android ? checkPhotoLocation : checkWindowsPhotoLocation;
      item.location = check(file, signal).catch(() => 'unknown');
    }
    const location = await item.location;
    if (signal.aborted || !checkbox.checked) return;
    warning.textContent = location === 'present'
      ? 'This original contains location metadata.'
      : 'Location metadata could not be checked for this original.';
    warning.hidden = location === 'none';
  }

  function open(items = getItems()) {
    locationController = new AbortController();
    media = items.filter(eligible).map(({ file, kind }) => {
      const row = document.createElement('div');
      row.className = 'fit-photo';
      const info = document.createElement('div');
      const name = document.createElement('span');
      name.textContent = `${file.name} · ${formatBytes(file.size)}`;
      const warning = document.createElement('small');
      warning.className = 'fit-photo-warning';
      warning.setAttribute('role', 'status');
      warning.hidden = true;
      info.append(name, warning);
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', `Keep original ${file.name}`);
      label.append(checkbox, 'Keep original');
      row.append(info, label);
      list.append(row);
      const item = { file, kind, checkbox, warning };
      checkbox.addEventListener('change', () => void inspectOriginal(item));
      return item;
    });
    privacyLabel.hidden = !media.some(item => item.kind === 'photo');
    dialog.showModal();
  }
  opener.addEventListener('click', () => open());

  form.addEventListener('input', reset);
  function showPart() {
    const output = outputs[part.selectedIndex];
    reviewFile.replaceChildren(...output.entries.map(entry => new Option(entry.name)));
    showReview();
    const label = outputs.length === 1 ? 'ZIP' : `ZIP ${part.selectedIndex + 1} of ${outputs.length}`;
    status.textContent = `${label} ready · ${output.blob.size.toLocaleString()} bytes`;
  }

  function prepareOutput(splitBatch) {
    if (outputs.length || task || !form.reportValidity()) return;
    void run(async signal => {
      const selected = media.map(({ file, kind, checkbox }) => {
        return { file, kind, keep: checkbox.checked, stripLocation: privacy.checked };
      });
      const cap = Math.round(limit.valueAsNumber * 1e6);
      const progress = message => { status.textContent = message; };
      let results;
      try {
        await Promise.all(media.map(inspectOriginal));
        signal.throwIfAborted();
        results = splitBatch
          ? await splitMedia(selected, cap, signal, progress)
          : [await fitMedia(selected, cap, signal, progress)];
      } catch (error) {
        if (error instanceof MediaError && !signal.aborted) canSplit = selected.length > 1;
        throw error;
      }
      if (signal.aborted) await Promise.all(results.map(result => result.dispose?.()));
      signal.throwIfAborted();
      outputs = results;
      for (const [index, output] of outputs.entries()) {
        part.add(new Option(`ZIP ${index + 1} of ${outputs.length} · ${formatBytes(output.blob.size)}`));
      }
      showPart();
    }, 'Couldn’t prepare the ZIP. Try again or choose fewer files.');
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    prepareOutput(false);
  });
  split.addEventListener('click', () => prepareOutput(true));

  part.addEventListener('change', showPart);
  reviewFile.addEventListener('change', showReview);
  reviewImage.addEventListener('error', () => {
    reviewImage.hidden = true;
    reviewError.hidden = false;
  });
  reviewVideo.addEventListener('error', () => {
    reviewVideo.hidden = true;
    reviewError.hidden = false;
  });
  reviewKeep.addEventListener('click', () => {
    const output = outputs[part.selectedIndex];
    if (task || !output) return;
    const entry = output.entries[reviewFile.selectedIndex];
    media.find(({ file }) => file === entry.file).checkbox.checked = true;
    const splitBatch = outputs.length > 1;
    reset();
    prepareOutput(splitBatch);
  });

  share.addEventListener('click', () => {
    const output = outputs[part.selectedIndex];
    if (!output) return;
    const { blob } = output;
    const suffix = outputs.length === 1 ? '' : `-${part.selectedIndex + 1}-of-${outputs.length}`;
    const name = `Pocketspace-Fit-to-Send${suffix}.zip`;
    if (!windows && !android) {
      if (!downloads.has(blob)) downloads.set(blob, mediaUrl(blob));
      const link = document.createElement('a');
      link.href = downloads.get(blob);
      link.download = name;
      link.click();
      return;
    }
    void run(async signal => {
      if (windows) {
        const saved = await saveWindowsZip(blob, name, signal);
        if (saved && !signal.aborted) status.textContent = `ZIP saved · ${blob.size.toLocaleString()} bytes`;
        return;
      }
      await shareMobile([{ file: blob, name }], signal);
      if (!signal.aborted) status.textContent = `Opened the share sheet · ${blob.size.toLocaleString()} bytes`;
    }, windows ? 'Couldn’t save the ZIP. Try saving again.' : 'Couldn’t open the share sheet. Try sharing again.');
  });

  dialog.addEventListener('close', () => {
    task?.abort();
    task = undefined;
    locationController.abort();
    media = [];
    list.replaceChildren();
    reset();
  });

  function eligible({ kind, file }) {
    return (kind === 'photo' || kind === 'video') && file.size > 0;
  }

  function update() {
    const items = getItems().filter(eligible);
    opener.hidden = !items.length;
    opener.disabled = items.some(item => item.pending || !item.ui.progress.hidden);
  }
  return { open, update };
}
