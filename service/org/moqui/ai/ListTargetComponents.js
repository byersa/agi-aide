// Pure QuickJS implementation of org.moqui.ai.ComponentServices.list#TargetComponents for MR-Moqui.

const PROTECTED_COMPONENTS = new Set([
    "agi-aide",
    "dev-aide",
    "moqui-usl",
    "mantle-usl",
    "webroot",
    "tools",
    "system",
    "framework",
    "basic-comms",
    "template"
]);

const COMPONENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SCAN_DIRS = [
    { set: "addon", relativeDir: "components/addon" },
    { set: "dev", relativeDir: "components/dev" },
    { set: "test", relativeDir: "components/test" },
    { set: "component", relativeDir: "component" }
];

function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function runListTargetComponents() {
    const runtimePath = normalizePath(ec.factory.getRuntimePath ? ec.factory.getRuntimePath() : "");
    const baseSetPrefix = runtimePath ? (runtimePath + "/components/base") : "";
    const byName = new Map();

    // 1. Scan runtime component directories (addon, dev, test, and component)
    for (const dir of SCAN_DIRS) {
        const rootLoc = "runtime://" + dir.relativeDir;
        let rootRef = null;
        try {
            rootRef = ec.resource.getLocationReference(rootLoc);
        } catch (e) {
            continue;
        }
        if (!rootRef || !rootRef.exists || !rootRef.isDirectory()) continue;

        let entries = [];
        try {
            entries = Array.from(rootRef.getDirectoryEntries() || []);
        } catch (e) {
            continue;
        }

        for (const entry of entries) {
            if (!entry || !entry.isDirectory()) continue;
            const name = String(entry.getName ? entry.getName() : (entry.fileName || "")).trim();
            if (!name || name.startsWith(".")) continue;
            if (!COMPONENT_NAME_PATTERN.test(name)) continue;
            if (PROTECTED_COMPONENTS.has(name.toLowerCase())) continue;

            const key = name.toLowerCase();
            if (!byName.has(key)) {
                const displayPath = runtimePath
                    ? (runtimePath + "/" + dir.relativeDir + "/" + name)
                    : (rootLoc + "/" + name);
                byName.set(key, {
                    name,
                    set: dir.set,
                    location: displayPath
                });
            }
        }
    }

    // 2. Include any additional loaded non-base, non-protected components from ExecutionContextFactory
    const baseLocations = ec.factory.getComponentBaseLocations ? ec.factory.getComponentBaseLocations() : {};
    if (baseLocations) {
        for (const [rawName, rawLoc] of Object.entries(baseLocations)) {
            const name = String(rawName || "").trim();
            if (!name || !COMPONENT_NAME_PATTERN.test(name)) continue;
            if (PROTECTED_COMPONENTS.has(name.toLowerCase())) continue;
            const normalized = normalizePath(rawLoc);
            if (baseSetPrefix && (normalized === baseSetPrefix || normalized.startsWith(baseSetPrefix + "/"))) {
                continue;
            }
            const key = name.toLowerCase();
            if (!byName.has(key)) {
                byName.set(key, {
                    name,
                    set: "loaded",
                    location: normalized
                });
            }
        }
    }

    const components = Array.from(byName.values()).sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    const componentNames = components.map(c => c.name);

    ec.context.components = components;
    ec.context.componentNames = componentNames;
}

runListTargetComponents();
