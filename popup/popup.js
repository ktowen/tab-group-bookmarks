// Internal URLs that cannot/should not be bookmarked
const INTERNAL_URL_RE = /^(chrome|chrome-extension|chrome-devtools|about|edge):\/\//;

function isBookmarkableUrl(url) {
  return !!url && !INTERNAL_URL_RE.test(url);
}

// ── State ─────────────────────────────────────────────────────────

let selectedGroup = null;   // { id, title, color, tabs[] }
let selectedFolderId = null;

// ── View Switching ────────────────────────────────────────────────

function showView(id) {
  for (const section of document.querySelectorAll('main section')) {
    section.hidden = section.id !== id;
  }
}

// ── Group List (View 1) ───────────────────────────────────────────

async function loadGroups() {
  const window = await chrome.windows.getCurrent();
  const groups = await chrome.tabGroups.query({ windowId: window.id });

  const result = [];
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const bookmarkableTabs = tabs.filter(t => isBookmarkableUrl(t.url));
    result.push({
      id: group.id,
      title: group.title || '',
      color: group.color,
      tabs: bookmarkableTabs,
    });
  }
  return result;
}

function renderGroupList(groups) {
  const list = document.getElementById('group-list');
  list.innerHTML = '';

  if (groups.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        No tab groups found in this window.<br>
        Group some tabs first using Chrome's tab groups.
      </div>`;
    return;
  }

  for (const group of groups) {
    const item = document.createElement('div');
    item.className = 'group-item';
    const displayName = group.title || getUnnamedGroupLabel(group.tabs);
    item.innerHTML = `
      <span class="color-dot ${group.color}"></span>
      <span class="group-name">${escapeHtml(displayName)}</span>
    `;
    item.addEventListener('click', () => onGroupSelected(group));
    list.appendChild(item);
  }
}

async function init() {
  try {
    const groups = await loadGroups();
    renderGroupList(groups);
  } catch (err) {
    console.error(err);
    document.getElementById('group-list').innerHTML =
      `<div class="empty-state">Failed to load tab groups.<br>${escapeHtml(err.message)}</div>`;
  }
}

// ── Group Selection ───────────────────────────────────────────────

function onGroupSelected(group) {
  selectedGroup = group;
  if (!group.title) {
    showNamePrompt();
  } else {
    showFolderPicker();
  }
}

// ── Name Prompt (View 2) ──────────────────────────────────────────

function showNamePrompt() {
  const input = document.getElementById('group-name-input');
  const continueBtn = document.getElementById('name-continue');
  const suggested = selectedGroup.tabs[0]?.title || '';
  input.value = suggested;
  continueBtn.disabled = suggested.trim() === '';
  showView('view-name');
  input.focus();
}

document.getElementById('group-name-input').addEventListener('input', (e) => {
  document.getElementById('name-continue').disabled = e.target.value.trim() === '';
});

document.getElementById('group-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !document.getElementById('name-continue').disabled) {
    onNameConfirmed();
  }
});

document.getElementById('name-cancel').addEventListener('click', () => {
  selectedGroup = null;
  showView('view-groups');
});

document.getElementById('name-continue').addEventListener('click', onNameConfirmed);

function onNameConfirmed() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) return;
  selectedGroup.title = name;
  showFolderPicker();
}

// ── Folder Picker (View 3) ────────────────────────────────────────

async function showFolderPicker() {
  selectedFolderId = null;
  document.getElementById('folder-save').disabled = true;
  showView('view-folders');

  const treeContainer = document.getElementById('folder-tree');
  treeContainer.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const [rootNode] = await chrome.bookmarks.getTree();
    treeContainer.innerHTML = '';
    // rootNode.children are the top-level containers
    for (const child of (rootNode.children || [])) {
      if (child.url) continue; // skip bookmarks at root (shouldn't exist but be safe)
      renderTreeNode(child, 0, treeContainer, true);
    }
  } catch (err) {
    console.error(err);
    treeContainer.innerHTML = `<div class="empty-state">Failed to load bookmarks.<br>${escapeHtml(err.message)}</div>`;
  }
}

function renderTreeNode(node, depth, container, expanded) {
  const childFolders = (node.children || []).filter(c => !c.url);
  const hasChildren = childFolders.length > 0;

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = `${4 + depth * 16}px`;
  row.innerHTML = `
    <span class="tree-arrow ${hasChildren ? '' : 'no-children'}">&#9654;</span>
    <span class="tree-icon">📁</span>
    <span class="folder-name">${escapeHtml(node.title)}</span>
  `;
  container.appendChild(row);

  row.addEventListener('click', () => {
    document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    selectedFolderId = node.id;
    document.getElementById('folder-save').disabled = false;
  });

  if (!hasChildren) return;

  const childrenDiv = document.createElement('div');
  childrenDiv.className = 'tree-children';
  container.appendChild(childrenDiv);

  const arrow = row.querySelector('.tree-arrow');

  function renderChildren() {
    if (childrenDiv.children.length > 0) return;
    for (const child of childFolders) {
      renderTreeNode(child, depth + 1, childrenDiv, false);
    }
  }

  if (expanded) {
    arrow.classList.add('open');
    childrenDiv.classList.add('open');
    renderChildren();
  }

  arrow.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = childrenDiv.classList.toggle('open');
    arrow.classList.toggle('open', isOpen);
    if (isOpen) renderChildren();
  });
}

document.getElementById('folder-cancel').addEventListener('click', () => {
  selectedFolderId = null;
  showView('view-groups');
});

document.getElementById('folder-save').addEventListener('click', saveBookmarks);

// ── Save Logic ────────────────────────────────────────────────────

async function saveBookmarks() {
  document.getElementById('folder-save').disabled = true;
  document.getElementById('folder-cancel').disabled = true;

  try {
    const folderId = await findOrCreateSubfolder(selectedFolderId, selectedGroup.title);
    const { added, skipped } = await addBookmarksToFolder(folderId, selectedGroup.tabs);

    let msg = `Saved ${added} bookmark${added !== 1 ? 's' : ''} to "${selectedGroup.title}"`;
    if (skipped > 0) msg += `\n${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped`;
    showResult(msg, false);

    setTimeout(() => window.close(), 2000);
  } catch (err) {
    console.error(err);
    showResult(`Error: ${err.message}`, true);
    document.getElementById('folder-cancel').disabled = false;
  }
}

async function findOrCreateSubfolder(parentId, name) {
  const children = await chrome.bookmarks.getChildren(parentId);
  const existing = children.find(c => !c.url && c.title === name);
  if (existing) return existing.id;
  const folder = await chrome.bookmarks.create({ parentId, title: name });
  return folder.id;
}

async function addBookmarksToFolder(folderId, tabs) {
  const existing = await chrome.bookmarks.getChildren(folderId);
  const existingUrls = new Set(existing.filter(b => b.url).map(b => b.url));

  let added = 0;
  let skipped = 0;

  for (const tab of tabs) {
    if (existingUrls.has(tab.url)) {
      skipped++;
    } else {
      await chrome.bookmarks.create({
        parentId: folderId,
        title: tab.title || tab.url,
        url: tab.url,
      });
      added++;
    }
  }

  return { added, skipped };
}

// ── Result (View 4) ───────────────────────────────────────────────

function showResult(message, isError) {
  const el = document.getElementById('result-message');
  el.className = isError ? 'error' : 'success';
  el.innerHTML = `
    <span class="result-icon">${isError ? '✕' : '✓'}</span>
    ${escapeHtml(message).replace(/\n/g, '<br>')}
  `;
  showView('view-result');
}

// ── Utilities ─────────────────────────────────────────────────────

function getUnnamedGroupLabel(tabs) {
  if (tabs.length === 0) return '(Empty group)';
  const firstTabName = tabs[0].title || tabs[0].url || 'Untitled';
  const groupName = firstTabName.length > 30 ? `${firstTabName.slice(0, 14)}...${firstTabName.slice(-14)}` : firstTabName;
  const others = tabs.length - 1;
  if (others === 0) return `"${groupName}"`;
  return `"${groupName}" and ${others} tab${others !== 1 ? 's' : ''}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Bootstrap ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
