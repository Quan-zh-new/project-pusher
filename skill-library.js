'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_SKILL_FILE_BYTES = 200 * 1024;
const MAX_SELECTED_SKILL_COUNT = 5;
const MAX_SELECTED_SKILL_BYTES = 32 * 1024;

function slug(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'; }
function rel(root, absolute) { return path.relative(root, absolute).split(path.sep).join('/'); }
function titleFor(filePath, content) { return String(content || '').match(/^\s*#\s+(.+)$/m)?.[1]?.trim().slice(0, 240) || path.basename(filePath, '.md'); }
function summaryFor(content) { return String(content || '').replace(/^\s*#.+$/m, '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360); }
function assertMarkdown(relativePath) { if (!/\.md$/i.test(relativePath || '')) throw Object.assign(new Error('Skill 必须是 Markdown 文件。'), { statusCode:422 }); }
function isInside(root, absolute) { const relative = path.relative(root, absolute); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }

async function ensureRoot(root) { await fs.mkdir(root, { recursive:true }); return fs.realpath(root); }
async function readMarkdown(absolute) { const stat = await fs.stat(absolute); if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) throw Object.assign(new Error('Skill 文件不存在、不是普通文件或超过 200KB。'), { statusCode:422 }); return fs.readFile(absolute, 'utf8'); }

async function scanSkillTree(root) {
  const resolvedRoot = await ensureRoot(root);
  const parents = [];
  const errors = [];
  const entries = await fs.readdir(resolvedRoot, { withFileTypes:true });
  for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const parentDir = path.join(resolvedRoot, entry.name);
    const direct = await fs.readdir(parentDir, { withFileTypes:true });
    const parentFiles = direct.filter((item) => item.isFile() && !item.isSymbolicLink() && /\.md$/i.test(item.name));
    if (parentFiles.length !== 1) { errors.push({ parentDir:rel(resolvedRoot, parentDir), error:parentFiles.length ? '父 Skill 目录只能包含一个顶层 .md 文件。' : '父 Skill 目录缺少顶层 .md 文件。' }); continue; }
    const parentAbsolute = path.join(parentDir, parentFiles[0].name);
    const parentContent = await readMarkdown(parentAbsolute);
    const children = [];
    const referencesDir = path.join(parentDir, 'references');
    const walk = async (dir) => {
      let nested = [];
      try { nested = await fs.readdir(dir, { withFileTypes:true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const child of nested.sort((a,b) => a.name.localeCompare(b.name))) {
        if (child.isSymbolicLink()) continue;
        const absolute = path.join(dir, child.name);
        if (child.isDirectory()) await walk(absolute);
        else if (child.isFile() && /\.md$/i.test(child.name)) {
          const content = await readMarkdown(absolute);
          children.push({ skillPath:rel(resolvedRoot, absolute), title:titleFor(absolute, content), summary:summaryFor(content), content, parentSkillPath:rel(resolvedRoot, parentAbsolute) });
        }
      }
    };
    await walk(referencesDir);
    parents.push({ skillPath:rel(resolvedRoot, parentAbsolute), parentDir:rel(resolvedRoot, parentDir), title:titleFor(parentAbsolute, parentContent), summary:summaryFor(parentContent), content:parentContent, children, childCount:children.length });
  }
  return { parents, errors };
}

async function searchSkills(root, { query = '', parentSkillPath = '', limit = 5 } = {}) {
  const tree = await scanSkillTree(root);
  const score = (item) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 1;
    const skillPath = String(item.skillPath || '').toLowerCase();
    const basename = path.posix.basename(skillPath, '.md');
    const hay = `${item.title}\n${item.summary}\n${item.content}`.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const contentScore = hay.includes(q) ? 12 : words.reduce((score, word) => score + (hay.includes(word) ? 3 : 0), 0);
    const identityScore = skillPath === q || skillPath.endsWith(`/${q}`) || basename === q
      ? 120
      : words.reduce((score, word) => score + (basename === word ? 90 : skillPath.includes(word) ? 15 : 0), 0);
    return identityScore + contentScore;
  };
  const count = Math.max(1, Math.min(Number(limit) || 5, 8));
  if (!parentSkillPath) return { level:'parent', items:tree.parents.map((item) => ({ item, score:score(item) })).filter(({score})=>score>0).sort((a,b)=>b.score-a.score||a.item.title.localeCompare(b.item.title)).slice(0,count).map(({item}) => ({ skillPath:item.skillPath, title:item.title, content:item.content, hasChildren:item.children.length>0, childCount:item.children.length })), errors:tree.errors };
  const parent = tree.parents.find((item) => item.skillPath === parentSkillPath);
  if (!parent) throw Object.assign(new Error('parentSkillPath 不是有效的父 Skill。'), { statusCode:422 });
  return { level:'child', parent:{ skillPath:parent.skillPath, title:parent.title, content:parent.content }, items:parent.children.map((item) => ({ item, score:score(item) })).filter(({score})=>score>0).sort((a,b)=>b.score-a.score||a.item.title.localeCompare(b.item.title)).slice(0,count).map(({item}) => ({ skillPath:item.skillPath, title:item.title, content:item.content, parentSkillPath:item.parentSkillPath })), errors:tree.errors };
}

async function selectSkillsForRun(root, skillPaths) {
  const tree = await scanSkillTree(root);
  const requested = [...new Set((Array.isArray(skillPaths) ? skillPaths : []).map(String))];
  if (!requested.length || requested.length > MAX_SELECTED_SKILL_COUNT) throw Object.assign(new Error(`skillPaths 需要 1-${MAX_SELECTED_SKILL_COUNT} 个 Skill。`), { statusCode:422 });
  const all = new Map();
  for (const parent of tree.parents) { all.set(parent.skillPath, { skillPath:parent.skillPath, title:parent.title, content:parent.content, parentSkillPath:parent.skillPath, kind:'parent' }); for (const child of parent.children) all.set(child.skillPath, { ...child, kind:'child' }); }
  const selected = requested.map((skillPath) => all.get(skillPath)).filter(Boolean);
  if (selected.length !== requested.length) throw Object.assign(new Error('只能选择 search_skills 返回的父或子 Skill 路径。'), { statusCode:422 });
  const parents = new Set(selected.map((item) => item.parentSkillPath));
  if (parents.size !== 1) throw Object.assign(new Error('一次只能绑定同一父 Skill 目录中的文件。'), { statusCode:422 });
  let bytes = 0;
  const refs = selected.map((item) => { bytes += Buffer.byteLength(item.content, 'utf8'); return { skillPath:item.skillPath, parentSkillPath:item.parentSkillPath, title:item.title, kind:item.kind, content:item.content, selectedAt:new Date().toISOString() }; });
  if (bytes > MAX_SELECTED_SKILL_BYTES) throw Object.assign(new Error(`选择的 Skill 正文合计不能超过 ${MAX_SELECTED_SKILL_BYTES / 1024}KB。`), { statusCode:422 });
  return refs;
}

async function uploadSkill(root, { parentSkillPath, filename, content }) {
  const tree = await scanSkillTree(root);
  const parent = tree.parents.find((item) => item.skillPath === String(parentSkillPath || ''));
  if (!parent) throw Object.assign(new Error('请先选择有效的父 Skill。'), { statusCode:422 });
  const name = path.basename(String(filename || ''));
  assertMarkdown(name);
  const body = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!body || Buffer.byteLength(body, 'utf8') > MAX_SKILL_FILE_BYTES) throw Object.assign(new Error('Skill 内容不能为空且不能超过 200KB。'), { statusCode:422 });
  const absolute = path.join(root, path.dirname(parent.skillPath), 'references', name);
  if (!isInside(root, absolute)) throw Object.assign(new Error('Skill 路径不安全。'), { statusCode:422 });
  await fs.mkdir(path.dirname(absolute), { recursive:true });
  await fs.writeFile(absolute, `${body}\n`, 'utf8');
  return { skillPath:rel(root, absolute), parentSkillPath:parent.skillPath, title:titleFor(absolute, body), summary:summaryFor(body) };
}

async function deleteSkill(root, skillPath) {
  const tree = await scanSkillTree(root);
  const item = tree.parents.flatMap((parent) => [{ skillPath:parent.skillPath, parentSkillPath:parent.skillPath, kind:'parent' }, ...parent.children.map((child) => ({ skillPath:child.skillPath, parentSkillPath:parent.skillPath, kind:'child' }))]).find((candidate) => candidate.skillPath === String(skillPath || ''));
  if (!item) throw Object.assign(new Error('Skill 不存在或不允许删除。'), { statusCode:404 });
  const absolute = path.join(root, item.skillPath);
  if (!isInside(root, absolute)) throw Object.assign(new Error('Skill 路径不安全。'), { statusCode:422 });
  await fs.unlink(absolute);
  return item;
}

async function migrateLegacySkills(root, state) {
  if (!state || state.skillFileMigrationVersion === 1) return false;
  const tree = await scanSkillTree(root);
  const existing = new Set(tree.parents.flatMap((parent) => [parent.skillPath, ...parent.children.map((child) => child.skillPath)]));
  const write = async (relativePath, content) => { const absolute=path.join(root, relativePath); if (existing.has(relativePath)) return; await fs.mkdir(path.dirname(absolute), {recursive:true}); await fs.writeFile(absolute, `${content.trim()}\n`, 'utf8'); existing.add(relativePath); };
  const manual=(state.skills || []).filter((skill) => skill?.kind === 'manual');
  if (manual.length) await write('imported-skills/imported-skills.md', '# Imported Skills\n\n从旧版运行时 Skill 库迁移的人工上传文件。');
  for (const skill of manual) await write(`imported-skills/references/${slug(skill.title)}.md`, `# ${skill.title}\n\n${skill.content}`);
  delete state.skills;
  delete state.cliSkills;
  state.skillFileMigrationVersion = 1;
  return true;
}

module.exports = { MAX_SELECTED_SKILL_COUNT, MAX_SELECTED_SKILL_BYTES, scanSkillTree, searchSkills, selectSkillsForRun, uploadSkill, deleteSkill, migrateLegacySkills };
