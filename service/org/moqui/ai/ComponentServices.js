// Pure QuickJS implementation of org.moqui.ai.ComponentServices.drop#Component for MR-Moqui.

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
    "base",
    "addon",
    "dev",
    "test"
]);

const COMPONENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const NON_BASE_COMPONENT_DIRS = ["components/addon", "components/dev", "components/test", "component", "components"];
const BATCH_SIZE = 500;

function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function toFileLocation(dirPath) {
    const normalized = normalizePath(dirPath);
    if (!normalized) return "";
    if (normalized.startsWith("file:")) return normalized;
    return normalized.startsWith("/") ? ("file://" + normalized) : ("file:" + normalized);
}

function chunksOf(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

function deleteByFieldIn(entityName, fieldName, ids) {
    if (!ids || ids.length === 0) return 0;
    let total = 0;
    for (const batch of chunksOf(ids, BATCH_SIZE)) {
        total += Number(ec.entity.find(entityName).condition(fieldName, "in", batch).deleteAll()) || 0;
    }
    return total;
}

function collectByFieldIn(entityName, fieldName, ids) {
    if (!ids || ids.length === 0) return [];
    const out = [];
    for (const batch of chunksOf(ids, BATCH_SIZE)) {
        const list = ec.entity.find(entityName).condition(fieldName, "in", batch).list();
        for (const item of Array.from(list)) out.push(item);
    }
    return out;
}

function resolveComponentTarget(compName) {
    const runtimePath = normalizePath(ec.factory.getRuntimePath ? ec.factory.getRuntimePath() : "");
    const baseSetPrefix = runtimePath ? (runtimePath + "/components/base") : "";

    // 1. Check loaded components from the ExecutionContextFactory (same source as dev-aide's roots.rs)
    const baseLocations = ec.factory.getComponentBaseLocations ? ec.factory.getComponentBaseLocations() : {};
    ec.logger.info("runDropComponent, runtimePath: " + runtimePath + ", baseSetPrefix : " + baseSetPrefix + ", JSON.stringify(baseLocations) : " + baseLocations);
    let loadedLocation = null;
    if (baseLocations) {
        if (baseLocations[compName]) {
            loadedLocation = baseLocations[compName];
        } else {
            const lower = compName.toLowerCase();
            for (const [name, loc] of Object.entries(baseLocations)) {
                if (name.toLowerCase() === lower) {
                    loadedLocation = loc;
                    break;
                }
            }
        }
    }

    if (loadedLocation) {
        const normalized = normalizePath(loadedLocation);
        if (baseSetPrefix && (normalized === baseSetPrefix || normalized.startsWith(baseSetPrefix + "/"))) {
            return { error: "Cannot drop base system component: " + compName };
        }
        const slashIdx = normalized.lastIndexOf("/");
        if (slashIdx <= 0) {
            return { error: "Refusing to delete unexpected component path: " + normalized };
        }
        const parentDir = normalized.slice(0, slashIdx);
        const leafName = normalized.slice(slashIdx + 1);
        if (leafName.toLowerCase() !== compName.toLowerCase()) {
            return { error: "Component directory leaf '" + leafName + "' does not match componentName '" + compName + "'." };
        }
        const parentLoc = toFileLocation(parentDir);
        const targetRef = ec.resource.getLocationReference(parentLoc + "/" + leafName);
        return {
            rootLocation: parentLoc,
            relativePath: leafName,
            displayPath: normalized,
            exists: Boolean(targetRef && targetRef.exists && targetRef.isDirectory())
        };
    }

    // 2. Fall back to runtime component directories (addon, dev, test, component, and direct components/)
    for (const rootRel of NON_BASE_COMPONENT_DIRS) {
        const rootLoc = "runtime://" + rootRel;
        const fullLoc = rootLoc + "/" + compName;
        const ref = ec.resource.getLocationReference(fullLoc);
        if (ref && ref.exists && ref.isDirectory()) {
            const displayPath = runtimePath
                ? (runtimePath + "/" + rootRel + "/" + compName)
                : fullLoc;
            return {
                rootLocation: rootLoc,
                relativePath: compName,
                displayPath,
                exists: true
            };
        }
    }

    return {
        rootLocation: null,
        relativePath: null,
        displayPath: null,
        exists: false
    };
}

function purgeComponentRecords(compName) {
    const counts = {
        AgiPipelineStepAssoc: 0,
        AgiPipelineStep: 0,
        AgiPayloadFacet: 0,
        AgiPayload: 0,
        AgiMessageContent: 0,
        AgiMessageFacet: 0,
        AgiMessage: 0,
        AgiDiscussionFacet: 0,
        AgiDiscussionRelationship: 0,
        AgiDiscussion: 0
    };

    // Collect AgiDiscussion IDs anchored to componentName
    const discussions = Array.from(
        ec.entity.find("org.moqui.ai.discussion.AgiDiscussion")
            .condition("targetComponent", compName)
            .list()
    );
    const discussionIds = discussions.map(d => String(d.discussionId));

    // Collect AgiPayload rows by targetComponent AND by discussionId
    const payloadMap = new Map();
    const payloadsByComp = Array.from(
        ec.entity.find("org.moqui.ai.payload.AgiPayload")
            .condition("targetComponent", compName)
            .list()
    );
    for (const p of payloadsByComp) payloadMap.set(String(p.agiPayloadId), p);
    for (const p of collectByFieldIn("org.moqui.ai.payload.AgiPayload", "discussionId", discussionIds)) {
        payloadMap.set(String(p.agiPayloadId), p);
    }
    const payloadIds = Array.from(payloadMap.keys());

    // Collect AgiPipelineStep rows by discussionId OR referencing any matched AgiPayload
    const stepMap = new Map();
    for (const s of collectByFieldIn("org.moqui.ai.pipeline.AgiPipelineStep", "discussionId", discussionIds)) {
        stepMap.set(String(s.pipelineStepId), s);
    }
    for (const s of collectByFieldIn("org.moqui.ai.pipeline.AgiPipelineStep", "ingressPayloadId", payloadIds)) {
        stepMap.set(String(s.pipelineStepId), s);
    }
    for (const s of collectByFieldIn("org.moqui.ai.pipeline.AgiPipelineStep", "egressPayloadId", payloadIds)) {
        stepMap.set(String(s.pipelineStepId), s);
    }
    const stepIds = Array.from(stepMap.keys());

    // Collect AgiMessage rows belonging to matched discussions
    const messageMap = new Map();
    for (const m of collectByFieldIn("org.moqui.ai.discussion.AgiMessage", "discussionId", discussionIds)) {
        messageMap.set(String(m.messageId), m);
    }
    const messageIds = Array.from(messageMap.keys());

    // 1. Delete AgiPipelineStepAssoc edges (references AgiPipelineStep)
    counts.AgiPipelineStepAssoc += deleteByFieldIn("org.moqui.ai.pipeline.AgiPipelineStepAssoc", "fromPipelineStepId", stepIds);
    counts.AgiPipelineStepAssoc += deleteByFieldIn("org.moqui.ai.pipeline.AgiPipelineStepAssoc", "toPipelineStepId", stepIds);

    // 2. Break self-referential and payload FKs on AgiPipelineStep, then delete AgiPipelineStep
    for (const extStep of collectByFieldIn("org.moqui.ai.pipeline.AgiPipelineStep", "parentStepId", stepIds)) {
        if (!stepMap.has(String(extStep.pipelineStepId))) {
            extStep.parentStepId = null;
            extStep.update();
        }
    }
    for (const s of stepMap.values()) {
        if (s.parentStepId || s.ingressPayloadId || s.egressPayloadId || s.userMessageId || s.assistantMessageId) {
            s.parentStepId = null;
            s.ingressPayloadId = null;
            s.egressPayloadId = null;
            s.userMessageId = null;
            s.assistantMessageId = null;
            s.update();
        }
    }
    counts.AgiPipelineStep += deleteByFieldIn("org.moqui.ai.pipeline.AgiPipelineStep", "pipelineStepId", stepIds);

    // 3. Delete AgiPayloadFacet (references AgiPayload)
    counts.AgiPayloadFacet += deleteByFieldIn("org.moqui.ai.payload.AgiPayloadFacet", "agiPayloadId", payloadIds);

    // 4. Break self-referential and message FKs on AgiPayload, then delete AgiPayload
    for (const extPayload of collectByFieldIn("org.moqui.ai.payload.AgiPayload", "parentPayloadId", payloadIds)) {
        if (!payloadMap.has(String(extPayload.agiPayloadId))) {
            extPayload.parentPayloadId = null;
            extPayload.update();
        }
    }
    for (const extMsgPayload of collectByFieldIn("org.moqui.ai.payload.AgiPayload", "messageId", messageIds)) {
        if (!payloadMap.has(String(extMsgPayload.agiPayloadId))) {
            extMsgPayload.messageId = null;
            extMsgPayload.update();
        }
    }
    for (const p of payloadMap.values()) {
        if (p.parentPayloadId || p.messageId || p.discussionId) {
            p.parentPayloadId = null;
            p.messageId = null;
            p.discussionId = null;
            p.update();
        }
    }
    counts.AgiPayload += deleteByFieldIn("org.moqui.ai.payload.AgiPayload", "agiPayloadId", payloadIds);

    // 5. Delete AgiMessageContent and AgiMessageFacet (reference AgiMessage)
    counts.AgiMessageContent += deleteByFieldIn("org.moqui.ai.discussion.AgiMessageContent", "messageId", messageIds);
    counts.AgiMessageFacet += deleteByFieldIn("org.moqui.ai.discussion.AgiMessageFacet", "messageId", messageIds);

    // 6. Break self-referential parentMessageId FKs on AgiMessage, then delete AgiMessage
    for (const extMsg of collectByFieldIn("org.moqui.ai.discussion.AgiMessage", "parentMessageId", messageIds)) {
        if (!messageMap.has(String(extMsg.messageId))) {
            extMsg.parentMessageId = null;
            extMsg.update();
        }
    }
    for (const m of messageMap.values()) {
        if (m.parentMessageId || m.stagedPayloadId) {
            m.parentMessageId = null;
            m.stagedPayloadId = null;
            m.update();
        }
    }
    counts.AgiMessage += deleteByFieldIn("org.moqui.ai.discussion.AgiMessage", "messageId", messageIds);

    // 7. Delete AgiDiscussionFacet and AgiDiscussionRelationship (reference AgiDiscussion)
    counts.AgiDiscussionFacet += deleteByFieldIn("org.moqui.ai.discussion.AgiDiscussionFacet", "discussionId", discussionIds);
    counts.AgiDiscussionRelationship += deleteByFieldIn("org.moqui.ai.discussion.AgiDiscussionRelationship", "parentDiscussionId", discussionIds);
    counts.AgiDiscussionRelationship += deleteByFieldIn("org.moqui.ai.discussion.AgiDiscussionRelationship", "childDiscussionId", discussionIds);

    // 8. Delete AgiDiscussion
    counts.AgiDiscussion += deleteByFieldIn("org.moqui.ai.discussion.AgiDiscussion", "discussionId", discussionIds);

    return counts;
}

function fail(compName, message) {
    ec.message.addError(message);
    ec.context.success = false;
    ec.context.componentName = compName;
    ec.context.directoryDeleted = false;
    ec.context.cachesCleared = false;
    ec.context.message = message;
}

function runDropComponent() {
    const compName = String(context.componentName || "").trim();

    if (!compName) {
        fail("", "componentName is required.");
        return;
    }

    if (!COMPONENT_NAME_PATTERN.test(compName)) {
        fail(compName, "Invalid componentName '" + compName + "'. Must start with a letter and contain only letters, digits, '-' or '_'.");
        return;
    }

    if (PROTECTED_COMPONENTS.has(compName.toLowerCase())) {
        fail(compName, "Cannot drop protected system component: " + compName);
        return;
    }

    const target = resolveComponentTarget(compName);
    ec.logger.info("runDropComponent, target: " + JSON.stringify(target) + ", compName: " + compName);
    if (target.error) {
        fail(compName, target.error);
        return;
    }

    // Purge database records in foreign-key-safe order
    const authzAlreadyDisabled = ec.artifactExecution.disableAuthz();
    let deletedRecords;
    try {
        deletedRecords = purgeComponentRecords(compName);
    } finally {
        if (!authzAlreadyDisabled) ec.artifactExecution.enableAuthz();
    }

    // Delete component directory from disk if present
    let directoryDeleted = false;
    let deletedDirectory = null;
    if (target.exists && target.rootLocation && target.relativePath) {
        const outcome = ec.resource
            .makeChangeSet(target.rootLocation)
            .delete(target.relativePath)
            .commit("Drop component " + compName);
        if (outcome && outcome.failures && outcome.failures.length > 0) {
            const first = outcome.failures[0];
            fail(
                compName,
                "Failed to delete component directory " + target.displayPath + ": " + (first.error || first.path || "unknown error")
            );
            return;
        }
        directoryDeleted = true;
        deletedDirectory = target.displayPath;
    }

    // Clear Moqui resource and screen caches
    let cachesCleared = false;
    try {
        ec.cache.clearCachesByPrefix("resource.");
        ec.cache.clearCachesByPrefix("screen.");
        ec.cache.clearAllCaches();
        cachesCleared = true;
    } catch (err) {
        ec.logger.warn("Failed to clear Moqui caches after dropping component " + compName, err);
    }

    ec.context.success = true;
    ec.context.componentName = compName;
    ec.context.deletedRecords = deletedRecords;
    ec.context.deletedDirectory = deletedDirectory;
    ec.context.directoryDeleted = directoryDeleted;
    ec.context.cachesCleared = cachesCleared;
    ec.context.message = "Dropped component '" + compName + "'" +
        (directoryDeleted ? (" and deleted " + deletedDirectory) : " (no component directory on disk)");
}

runDropComponent();
