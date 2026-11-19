# Architecture Directives: AGI-AIDE (MR-Moqui)
<!-- Canonical domain specification for agi-aide. High-level invariants, dev-aide integration contracts, and non-expert UX goals. -->

## 1. Core Mission & Non-Expert UX Invariants
- **Primary Goal:** Enable a non-expert ERP developer or business actor to go from an idea to a working, Mantle UDM-compliant Moqui application through a guided **Discuss -> Plan -> Build** workflow without getting lost in XML schemas, entity definitions, or Git plumbing.
- **Progressive Disclosure:** Hide low-level XML/JSON internals behind structured contracts (5-pillars JSON), single-click stage transitions (`Discuss` -> `Plan` -> `Build`), and sensible defaults (auto-selecting the active initiative and root step on load).
- **Direct Dev-AIDE Handoff:** Hand off concrete screen/entity/service editing and Git repository operations directly to `dev-aide` (`/qapps/dev/Screens/Design`, `/qapps/dev/Workspace`, `/qapps/dev/Repositories`).

## 2. Runtime & Backend Service Architecture (MR-Moqui)
- **Pure QuickJS Services:** All backend services in `agi-aide` MUST be written in pure QuickJS (`type="script"` pointing to `.js` files) or declarative XML entity-auto actions—never Groovy or Java.
- **No `mcp/` Directory:** Dispense with legacy `mcp/instructions/` directories. Align 100% with `dev-aide`'s native `prompt/` and `skill/` folder conventions.
- **Component Paths:** Target user components live under `runtime/component/<targetComponent>/` (singular `component/`, matching `mr-moqui`'s runtime user-component root; check `runtime/components/<targetComponent>/` only as a secondary fallback). Framework/dev components reside under `runtime/components/dev/`.
- **Protected System Components:** Never allow deletion or mutation of `agi-aide`, `dev-aide`, `moqui-usl`, `mantle-usl`, `webroot`, `tools`, or `system`.

## 3. Layered Instruction Resolution (`prompt/` + `skill/` Cascade)
When assembling `systemInstruction` for a pipeline step (`mode` in `discuss`, `plan`, `build`, `test`) and `targetComponent` (`comp`), resolve and concatenate layers in this exact order:
1. **Layer 1 — Base Platform Prompt:**
   - `component://agi-aide/prompt/agi.md` (with `component://dev-aide/prompt/dev.md` conventions)
2. **Layer 2 — Target Component Domain Directives (`component.md`):**
   - `component://${comp}/prompt/component.md`
3. **Layer 3 — Artifact & Mode Skill Cascade (first match wins):**
   - Exact artifact override: `component://${comp}/skill/${dirPath}/${baseName}/${mode}.md`
   - Directory scope override: `component://${comp}/skill/${dirPath}/${mode}.md`
   - Component category scope: `component://${comp}/skill/${artifactCategory}/${mode}.md` (e.g., `skill/screen/plan.md`, `skill/screen/build.md`)
   - Component generic fallback: `component://${comp}/skill/generic/${mode}.md`
   - Platform `agi-aide` category default: `component://agi-aide/skill/${artifactCategory}/${mode}.md`
   - Platform `agi-aide` generic default: `component://agi-aide/skill/generic/${mode}.md`
4. **Layer 4 — Dev-AIDE Technical Reference Skills:**
   - Include matching `component://dev-aide/skill/${artifactCategory}-xml.md` (e.g., `entity-xml.md`, `service-xml.md`, `screen-xml.md`, `qvue-screens.md`) during `plan` and `build` modes so generated artifacts obey current `mr-moqui` XML/QVue rules.
5. **Layer 5 — Compliance & Behavioral Facets:**
   - `component://${comp}/skill/facets/${facetKey}.md` -> `component://agi-aide/skill/facets/${facetKey}.md` (e.g., `hipaa.md`, `multi-tenant.md`).

## 4. Target Component Scaffolding & Lifecycle (`create#Component` / `drop#Component`)
- **Scaffolding (`create#Component`):**
  - Creates `runtime/component/<targetComponent>/` with `prompt/component.md` and `skill/{screen,entity,service,generic}/` folders.
  - Registers Git tracking via `dev-aide`'s workspace/git primitives (`dev_aide::workspace` / `WorkspaceServices`).
- **Purging (`drop#Component`):**
  - Purges `AgiPipelineStep`, `AgiPayload` (and facets), `AgiMessage` (and content/facets), and `AgiDiscussion` (and facets/relationships) for `targetComponent` in foreign-key-safe order.
  - Resolves and removes `runtime/component/<targetComponent>/` (checking `runtime/components/<targetComponent>/` as a secondary fallback) from disk and clears resource/screen caches.

## 5. Frontend QVT / QVue Conventions
- **Outer Shell (`Studio.qvue`):** Mounted at `/qapps/agi/Studio` via `AgiAide.xml` (`<subscreens-panel type="popup"/>`) and `AgiAide/Studio.xml` (`render-modes="qvue"`).
- **Static Assets (`/agistatic/`):** Served via `agistatic.xml` mounted under `webroot.xml` in `MoquiConf.xml`.
- **Network Helper:** Use the `window.axios` fetch-backed shim in `Studio.qvue` (injecting `moquiSessionToken`) so all `.qvt.js` components communicate cleanly with `/rest/s1/agi-ai/...`.