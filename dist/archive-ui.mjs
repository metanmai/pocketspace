import { archiveZip, availableItems, syncArchive, variantFile, zipLimit } from './archive.mjs';

export function bindArchive(getItems) {
  const dialog = document.getElementById('archive');
  const opener = document.getElementById('open-archive');
  const share = dialog.querySelector('#archive-share');
  const zip = dialog.querySelector('#archive-zip');
  const download = dialog.querySelector('#archive-download');
  const folder = dialog.querySelector('#archive-folder');
  const status = dialog.querySelector('#archive-status');
  const choices = dialog.querySelector('fieldset');
  const zipHelp = dialog.querySelector('#archive-zip-help');
  const shareHelp = dialog.querySelector('#archive-share-help');
  const cloudHelp = dialog.querySelector('#archive-cloud-help');
  const windowsApp = window.pocketspaceHost === 'windows';
  const pickerSupported = typeof window.showDirectoryPicker === 'function' && window.top === window;
  if (windowsApp) zip.querySelector('span').textContent = 'Prepare ZIP to share';
  let packageUrl;
  let task;
  let snapshot = [];

  function selected() {
    const variant = choices.querySelector(':checked').value;
    const items = availableItems(snapshot, variant);
    return { variant, items };
  }

  function shareData(items, variant) {
    return { files: items.map(item => variantFile(item, variant)) };
  }

  function canShare(items, variant) {
    if (windowsApp || !items.length || !navigator.share || !navigator.canShare) return false;
    try { return navigator.canShare(shareData(items, variant)); } catch { return false; }
  }

  function render() {
    const { variant, items } = selected();
    const fileCount = items.length;
    const tooLarge = items.reduce((sum, item) => sum + (variant === 'originals' ? item.file.size : item.result.blob.size), 0) > zipLimit;
    const canShareFiles = canShare(items, variant);
    choices.disabled = Boolean(task);
    share.hidden = !canShareFiles;
    share.disabled = Boolean(task);
    folder.hidden = !pickerSupported;
    folder.disabled = Boolean(task) || !fileCount;
    zip.hidden = Boolean(packageUrl);
    zip.disabled = Boolean(task) || !fileCount || tooLarge;
    download.hidden = !packageUrl;
    zipHelp.hidden = !tooLarge;
    if (windowsApp) {
      shareHelp.textContent = 'Prepare and save a ZIP, then add it in LocalSend to send it over the same Wi-Fi.';
    } else {
      shareHelp.textContent = canShareFiles
        ? 'Choose LocalSend in the share menu, then select a device on the same Wi-Fi.'
        : 'Download the ZIP and add it in LocalSend to send it over the same Wi-Fi.';
    }
    cloudHelp.textContent = pickerSupported
      ? 'Select a folder managed by your sync app. Pocketspace saves missing files and an index that matches each original to its copy.'
      : 'Save the ZIP to a folder managed by your sync app. Its index matches each original to its copy.';
    dialog.querySelector('#archive-selection').textContent = fileCount
      ? `${fileCount} ${variant === 'originals' ? 'original' : 'compressed'} ${fileCount === 1 ? 'file' : 'files'} selected`
      : 'No compressed copies are available for this batch.';
  }

  function resetZip() {
    if (packageUrl) URL.revokeObjectURL(packageUrl);
    packageUrl = undefined;
    download.removeAttribute('href');
  }

  async function run(action, fallback) {
    if (task) return;
    const controller = new AbortController();
    const { signal } = controller;
    task = controller;
    status.textContent = '';
    render();
    try {
      await action(selected(), signal);
    } catch (error) {
      if (!signal.aborted && error.name !== 'AbortError') status.textContent = fallback;
    } finally {
      if (task === controller) {
        task = undefined;
        render();
      }
    }
  }

  opener.addEventListener('click', () => {
    snapshot = getItems().slice();
    if (!availableItems(snapshot, 'originals').length) return;
    choices.querySelector('[value="originals"]').checked = true;
    status.textContent = '';
    render();
    dialog.showModal();
  });

  choices.addEventListener('change', () => {
    resetZip();
    status.textContent = '';
    render();
  });
  dialog.addEventListener('close', () => {
    task?.abort();
    task = undefined;
    snapshot = [];
    resetZip();
  });

  if (!windowsApp) {
    share.addEventListener('click', () => void run(async ({ items, variant }, signal) => {
      await navigator.share(shareData(items, variant));
      if (!signal.aborted) status.textContent = 'Handed to the share menu. Check your receiving device for the transfer.';
    }, 'The share menu couldn’t send these files. Try downloading the ZIP.'));
  }

  zip.addEventListener('click', () => void run(async ({ items, variant }, signal) => {
    status.textContent = 'Preparing ZIP and matching-file index…';
    const blob = await archiveZip(items, variant, signal);
    signal.throwIfAborted();
    packageUrl = URL.createObjectURL(blob);
    download.href = packageUrl;
    download.download = `Pocketspace-${variant}.zip`;
    status.textContent = 'ZIP ready. It includes an index linking originals and compressed copies.';
    render();
    download.focus();
  }, 'Couldn’t prepare the ZIP. Try a smaller batch.'));

  folder.addEventListener('click', () => void run(async ({ items, variant }, signal) => {
    const destination = await window.showDirectoryPicker({ mode: 'readwrite', id: 'pocketspace-archive' });
    signal.throwIfAborted();
    const { added, existing } = await syncArchive(destination, items, variant, signal, (index, total) => {
      status.textContent = `Saving file ${index} of ${total}…`;
    });
    signal.throwIfAborted();
    status.textContent = `${added} saved and ${existing} already present in Pocketspace Archive. Check your sync app for upload status.`;
  }, 'Folder sync couldn’t finish. You can retry with the same folder or download the ZIP.'));

  return () => {
    const items = getItems();
    opener.hidden = !availableItems(items, 'originals').length;
    opener.disabled = items.some(item => item.pending || !item.ui.progress.hidden);
  };
}
