/**
 * SpecFlow Gate Registry
 *
 * Centralized, idempotent gate state for phase transitions.
 * Runtime state (active group, retry count, etc.) stays in specflow-state.json;
 * phase readiness decisions are recorded here as first-class gates.
 */

const fs = require('fs')
const path = require('path')

const UTF8 = 'utf-8'
const GATES_FILE = '.temp/gates.json'
const GATES_VERSION = 1

const VALID_STATUS = new Set(['pending', 'passed', 'blocked', 'invalidated', 'skipped'])
const VALID_STAGE = new Set(['Init', 'Specify', 'PlanReadiness', 'Plan', 'Implement', 'QA', 'Archive'])
const VALID_SCOPE = new Set(['global', 'requirement', 'plan', 'group'])
const VALID_KIND = new Set(['artifact', 'ack', 'computed', 'state'])

const GATE_SCHEMA = {
  idPattern: /^[a-z][a-z0-9_.:-]*$/i,
  statuses: Array.from(VALID_STATUS),
  stages: Array.from(VALID_STAGE),
  scopes: Array.from(VALID_SCOPE),
  kinds: Array.from(VALID_KIND),
}

const GATE_DEFINITIONS = {
  'init.global_assets': {
    stage: 'Init',
    scope: 'global',
    kind: 'artifact',
    required: true,
  },
  'init.architecture_layers': {
    stage: 'Init',
    scope: 'global',
    kind: 'artifact',
    required: true,
  },
  'init.domain_refs': {
    stage: 'Init',
    scope: 'requirement',
    kind: 'ack',
    required: true,
  },
  'specify.product_clarification': {
    stage: 'Specify',
    scope: 'requirement',
    kind: 'computed',
    required: true,
  },
  'specify.document_ready': {
    stage: 'Specify',
    scope: 'requirement',
    kind: 'computed',
    required: true,
    snapshotRequired: true,
  },
  'plan.readiness_review': {
    stage: 'PlanReadiness',
    scope: 'requirement',
    kind: 'ack',
    required: true,
    snapshotRequired: true,
  },
  'plan.user_confirm_start': {
    stage: 'PlanReadiness',
    scope: 'requirement',
    kind: 'ack',
    required: true,
    snapshotRequired: true,
  },
  'plan.document_ready': {
    stage: 'Plan',
    scope: 'plan',
    kind: 'artifact',
    required: true,
    snapshotRequired: true,
  },
  'implement.completion_packet_ready': {
    stage: 'Implement',
    scope: 'group',
    kind: 'artifact',
    required: true,
  },
  'qa.lite_evidence_ready': {
    stage: 'QA',
    scope: 'group',
    kind: 'artifact',
    required: true,
  },
  'archive.user_anchor': {
    stage: 'Archive',
    scope: 'requirement',
    kind: 'ack',
    required: true,
  },
  'archive.domain_merged': {
    stage: 'Archive',
    scope: 'requirement',
    kind: 'artifact',
    required: true,
  },
  'archive.knowledge_reviewed': {
    stage: 'Archive',
    scope: 'requirement',
    kind: 'ack',
    required: true,
  },
}

function getGatesPath(requirementDir) {
  return path.join(requirementDir, GATES_FILE)
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, UTF8))
  } catch {
    return fallback
  }
}

function sanitizeGateId(id) {
  const text = String(id || '').trim()
  if (!GATE_SCHEMA.idPattern.test(text)) return ''
  return text.slice(0, 120)
}

function sanitizeStatus(status) {
  const s = String(status || '').trim().toLowerCase()
  return VALID_STATUS.has(s) ? s : 'pending'
}

function sanitizeGate(raw, idHint) {
  const gate = raw && typeof raw === 'object' ? raw : {}
  const id = sanitizeGateId(gate.id || idHint)
  if (!id) return null
  const def = GATE_DEFINITIONS[id]
  const out = {
    id,
    status: sanitizeStatus(gate.status),
  }
  if (def) {
    out.stage = def.stage
    out.scope = def.scope
  }
  for (const key of ['stage', 'scope', 'subject', 'reason', 'updatedAt']) {
    if ((key === 'stage' || key === 'scope') && def) continue
    if (typeof gate[key] === 'string' && gate[key].trim()) out[key] = gate[key].trim().slice(0, 1000)
  }
  if (gate.snapshot && typeof gate.snapshot === 'object' && !Array.isArray(gate.snapshot)) {
    out.snapshot = sanitizeSnapshot(gate.snapshot)
  }
  if (Array.isArray(gate.evidence)) {
    out.evidence = gate.evidence
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((x) => x.slice(0, 1000))
  }
  if (Array.isArray(gate.history)) {
    out.history = gate.history
      .filter((x) => x && typeof x === 'object')
      .slice(-40)
      .map((x) => ({
        status: sanitizeStatus(x.status),
        at: typeof x.at === 'string' ? x.at.slice(0, 40) : new Date(0).toISOString(),
        reason: typeof x.reason === 'string' ? x.reason.slice(0, 1000) : undefined,
      }))
  }
  return out
}

function hasSnapshotValue(snapshot) {
  const s = sanitizeSnapshot(snapshot || {})
  return Boolean(
    s.hash ||
    (s.files && typeof s.files === 'object' && Object.keys(s.files).length > 0),
  )
}

function getGateDefinition(gateId) {
  const id = sanitizeGateId(gateId)
  return id ? GATE_DEFINITIONS[id] || null : null
}

function validateGate(gate, options = {}) {
  const g = sanitizeGate(gate, gate && gate.id)
  if (!g) return { ok: false, error: 'invalid gate shape' }
  const def = getGateDefinition(g.id)
  if (!def && options.allowUnknown !== true) {
    return { ok: false, error: `unknown gate id: ${g.id}` }
  }
  if (def) {
    if (g.stage !== def.stage) {
      return { ok: false, error: `gate ${g.id} stage must be ${def.stage}` }
    }
    if (g.scope !== def.scope) {
      return { ok: false, error: `gate ${g.id} scope must be ${def.scope}` }
    }
    if (def.snapshotRequired && (g.status === 'passed' || g.status === 'blocked') && !hasSnapshotValue(g.snapshot)) {
      return { ok: false, error: `gate ${g.id} requires snapshot for ${g.status}` }
    }
  }
  if (g.status === 'blocked' && !String(g.reason || '').trim()) {
    return { ok: false, error: `gate ${g.id} blocked status requires reason` }
  }
  if (g.status === 'passed' && (!Array.isArray(g.evidence) || g.evidence.length === 0)) {
    return { ok: false, error: `gate ${g.id} passed status requires evidence` }
  }
  return { ok: true, gate: g, definition: def }
}

function sanitizeSnapshot(snapshot) {
  const out = {}
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    if (snapshot.hash != null) out.hash = String(snapshot.hash).slice(0, 160)
    if (snapshot.files && typeof snapshot.files === 'object' && !Array.isArray(snapshot.files)) {
      const files = {}
      for (const [k, v] of Object.entries(snapshot.files)) {
        const key = String(k || '').trim().slice(0, 240)
        if (!key) continue
        if (typeof v === 'number' && Number.isFinite(v)) files[key] = v
        else if (typeof v === 'string' && v.trim()) files[key] = v.trim().slice(0, 160)
      }
      if (Object.keys(files).length > 0) out.files = files
    }
  }
  return out
}

function snapshotsEqual(a, b) {
  const aa = sanitizeSnapshot(a || {})
  const bb = sanitizeSnapshot(b || {})
  return JSON.stringify(aa) === JSON.stringify(bb)
}

function readGates(requirementDir) {
  const file = getGatesPath(requirementDir)
  const raw = safeReadJson(file, {})
  const out = { version: GATES_VERSION, gates: {} }
  const gates = raw && typeof raw === 'object' && raw.gates && typeof raw.gates === 'object'
    ? raw.gates
    : {}
  for (const [id, gate] of Object.entries(gates)) {
    const clean = sanitizeGate(gate, id)
    if (!clean) continue
    const validation = validateGate(clean, { allowUnknown: true })
    if (validation.ok) out.gates[clean.id] = validation.gate
  }
  return out
}

function writeGates(requirementDir, registry) {
  const file = getGatesPath(requirementDir)
  ensureDir(path.dirname(file))
  const clean = { version: GATES_VERSION, gates: {} }
  const gates = registry && registry.gates && typeof registry.gates === 'object' ? registry.gates : {}
  for (const [id, gate] of Object.entries(gates)) {
    const g = sanitizeGate(gate, id)
    if (!g) continue
    const validation = validateGate(g, { allowUnknown: true })
    if (validation.ok) clean.gates[g.id] = validation.gate
  }
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), UTF8)
  return clean
}

function updateGate(requirementDir, gateId, patch) {
  const id = sanitizeGateId(gateId)
  if (!id) return { ok: false, error: 'invalid gate id' }
  const def = getGateDefinition(id)
  if (!def) return { ok: false, error: `unknown gate id: ${id}` }
  const registry = readGates(requirementDir)
  const prev = registry.gates[id] || { id, status: 'pending' }
  const now = new Date().toISOString()
  const next = sanitizeGate({
    ...prev,
    ...patch,
    id,
    updatedAt: now,
    history: [
      ...(Array.isArray(prev.history) ? prev.history : []),
      {
        status: patch.status || prev.status || 'pending',
        at: now,
        reason: patch.reason || '',
      },
    ],
  }, id)
  const validation = validateGate(next)
  if (!validation.ok) return validation
  registry.gates[id] = validation.gate
  writeGates(requirementDir, registry)
  return { ok: true, gate: validation.gate }
}

function passGate(requirementDir, gateId, options = {}) {
  const def = getGateDefinition(gateId)
  return updateGate(requirementDir, gateId, {
    status: 'passed',
    stage: def ? def.stage : options.stage,
    scope: def ? def.scope : options.scope,
    subject: options.subject,
    reason: options.reason,
    snapshot: sanitizeSnapshot(options.snapshot || {}),
    evidence: normalizeEvidence(options.evidence),
  })
}

function blockGate(requirementDir, gateId, options = {}) {
  const def = getGateDefinition(gateId)
  return updateGate(requirementDir, gateId, {
    status: 'blocked',
    stage: def ? def.stage : options.stage,
    scope: def ? def.scope : options.scope,
    subject: options.subject,
    reason: String(options.reason || 'blocked').trim(),
    snapshot: sanitizeSnapshot(options.snapshot || {}),
    evidence: normalizeEvidence(options.evidence),
  })
}

function skipGate(requirementDir, gateId, options = {}) {
  const def = getGateDefinition(gateId)
  return updateGate(requirementDir, gateId, {
    status: 'skipped',
    stage: def ? def.stage : options.stage,
    scope: def ? def.scope : options.scope,
    subject: options.subject,
    reason: options.reason,
    snapshot: sanitizeSnapshot(options.snapshot || {}),
    evidence: normalizeEvidence(options.evidence),
  })
}

function invalidateGate(requirementDir, gateId, options = {}) {
  const def = getGateDefinition(gateId)
  return updateGate(requirementDir, gateId, {
    status: 'invalidated',
    stage: def ? def.stage : options.stage,
    scope: def ? def.scope : options.scope,
    subject: options.subject,
    reason: String(options.reason || 'snapshot changed').trim(),
    snapshot: sanitizeSnapshot(options.snapshot || {}),
    evidence: normalizeEvidence(options.evidence),
  })
}

function resetGate(requirementDir, gateId, options = {}) {
  const def = getGateDefinition(gateId)
  return updateGate(requirementDir, gateId, {
    status: 'pending',
    stage: def ? def.stage : options.stage,
    scope: def ? def.scope : options.scope,
    subject: options.subject,
    reason: options.reason || '',
    snapshot: sanitizeSnapshot(options.snapshot || {}),
    evidence: normalizeEvidence(options.evidence),
  })
}

function normalizeEvidence(evidence) {
  if (Array.isArray(evidence)) return evidence.map((x) => String(x || '').trim()).filter(Boolean)
  const text = String(evidence || '').trim()
  return text ? [text] : []
}

function getGate(registryOrDir, gateId) {
  const registry = typeof registryOrDir === 'string' ? readGates(registryOrDir) : registryOrDir
  const id = sanitizeGateId(gateId)
  return id && registry && registry.gates ? registry.gates[id] || null : null
}

function gatePassed(registryOrDir, gateId, options = {}) {
  const gate = getGate(registryOrDir, gateId)
  if (!gate) return false
  if (gate.status !== 'passed' && gate.status !== 'skipped') return false
  if (options.snapshot && gate.snapshot && !snapshotsEqual(gate.snapshot, options.snapshot)) return false
  if (options.snapshot && !gate.snapshot) return false
  return true
}

function fileSnapshot(workspaceRoot, entries) {
  const files = {}
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (!entry) continue
    const rel = path.relative(workspaceRoot, path.resolve(workspaceRoot, entry)).replace(/\\/g, '/')
    try {
      files[rel] = fs.statSync(path.resolve(workspaceRoot, entry)).mtimeMs
    } catch {
      files[rel] = 0
    }
  }
  return { files }
}

function main() {
  const { parseCliArgs, resolveWorkspace, resolveRequirementId } = require('./cli-args.cjs')
  const argv = process.argv.slice(2)
  const action = argv[0] || 'status'
  const { named, positional } = parseCliArgs(argv.slice(1))
  const workspaceRoot = path.resolve(resolveWorkspace(named, positional, 0))
  const requirementId = resolveRequirementId(named, positional, 1)
  const requirementDir = path.join(workspaceRoot, 'ai-docs', requirementId || '')
  if (!requirementId) {
    console.log(JSON.stringify({ ok: false, error: 'missing requirement id' }, null, 2))
    process.exit(1)
  }

  if (action === 'status') {
    console.log(JSON.stringify(readGates(requirementDir), null, 2))
    return
  }

  const gateId = named.gate || named.id || positional[2]
  const opts = {
    stage: named.stage,
    scope: named.scope,
    subject: named.subject,
    reason: named.reason,
    evidence: named.evidence,
  }
  let result
  if (action === 'pass') result = passGate(requirementDir, gateId, opts)
  else if (action === 'block') result = blockGate(requirementDir, gateId, opts)
  else if (action === 'skip') result = skipGate(requirementDir, gateId, opts)
  else if (action === 'invalidate') result = invalidateGate(requirementDir, gateId, opts)
  else if (action === 'reset') result = resetGate(requirementDir, gateId, opts)
  else result = { ok: false, error: `unknown action: ${action}` }
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exit(1)
}

if (require.main === module) {
  main()
}

module.exports = {
  GATES_FILE,
  GATES_VERSION,
  GATE_SCHEMA,
  GATE_DEFINITIONS,
  getGatesPath,
  getGateDefinition,
  validateGate,
  readGates,
  writeGates,
  passGate,
  blockGate,
  skipGate,
  invalidateGate,
  resetGate,
  getGate,
  gatePassed,
  fileSnapshot,
  sanitizeSnapshot,
  snapshotsEqual,
}
