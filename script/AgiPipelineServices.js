/* Pure QuickJS Implementation of AGI Pipeline & Discussion Services for MR-Moqui */

function normalizeStance(raw) {
    const s = String(raw || "plan").toLowerCase().trim();
    if (s === "aambuild" || s === "build") return "AamBuild";
    if (s === "aamdiscuss" || s === "discuss") return "AamDiscuss";
    return "AamPlan";
}

function stanceToMode(stanceEnumId) {
    const s = String(stanceEnumId || "").toLowerCase();
    if (s === "aambuild" || s === "build") return "build";
    if (s === "aamdiscuss" || s === "discuss") return "discuss";
    return "plan";
}

function recordTurn(ec, params) {
    const msg = ec.entity.makeValue("org.moqui.ai.discussion.AgiMessage");
    msg.discussionId = params.discussionId;
    msg.parentMessageId = params.parentMessageId || null;
    msg.senderRoleEnumId = params.senderRoleEnumId || "AsrUser";
    msg.partyId = params.senderRoleEnumId === "AsrAssistant" ? null : (ec.user.userId || null);
    msg.statusId = "AmsActive";
    msg.targetArtifactUri = params.targetArtifactUri || null;
    msg.entryDate = ec.user.nowTimestamp;
    msg.setSequencedIdPrimary();
    msg.create();

    const content = ec.entity.makeValue("org.moqui.ai.discussion.AgiMessageContent");
    content.messageId = msg.messageId;
    content.contentSeqId = "1";
    content.contentTypeEnumId = "mctMarkdown";
    content.title = params.title || String(params.content || "").slice(0, 40);
    content.bodyText = params.content || "";
    content.create();

    const disc = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion")
        .condition("discussionId", params.discussionId).one();
    if (disc) {
        disc.messageCount = (Number(disc.messageCount) || 0) + 1;
        disc.lastActivityDate = ec.user.nowTimestamp;
        disc.update();
    }
    return String(msg.messageId);
}

function getPipelineGraph(context) {
    const ec = context.ec;
    const comp = String(context.targetComponent || "").trim();
    const discId = context.discussionId ? String(context.discussionId) : null;
    const showArchived = context.includeArchived === "Y" || context.includeArchived === true;

    const discFind = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion");
    if (comp) discFind.condition("targetComponent", "in", [comp, null, ""]);
    if (!showArchived) discFind.condition("statusId", "not-equals", "AgdStatusArchived");
    const discussions = Array.from(discFind.orderBy("-lastActivityDate, -fromDate, -discussionId").list());

    context.initiatives = discussions.map(disc => {
        const dId = String(disc.discussionId);
        let terminalStage = "discuss";
        const lastStep = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep")
            .condition("discussionId", dId)
            .orderBy("-stepSequenceNum, -createdDate")
            .limit(1).one();
        if (lastStep) {
            terminalStage = stanceToMode(lastStep.stanceEnumId);
        }
        return {
            discussionId: dId,
            name: disc.name || ("Pipeline #" + dId),
            shortName: disc.shortName || "",
            targetComponent: disc.targetComponent || comp,
            targetArtifactUri: disc.targetArtifactUri || "",
            statusId: disc.statusId,
            isArchived: disc.statusId === "AgdStatusArchived",
            promotedWorkEffortId: disc.promotedWorkEffortId || null,
            messageCount: Number(disc.messageCount) || 0,
            lastActivityDate: disc.lastActivityDate ? String(disc.lastActivityDate) : "",
            terminalStage: terminalStage
        };
    });

    const nodes = [];
    const edges = [];
    const addedEdges = new Set();

    if (discId) {
        const stepFind = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep")
            .condition("discussionId", discId);
        if (!showArchived) stepFind.condition("statusId", "not-equals", "PlsArchived");
        const steps = Array.from(stepFind.orderBy("stepSequenceNum, createdDate").list());

        const stepIds = steps.map(s => String(s.pipelineStepId));
        const assocList = stepIds.length > 0
            ? Array.from(ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStepAssoc").condition("toPipelineStepId", "in", stepIds).list())
            : [];

        for (const s of steps) {
            const sId = String(s.pipelineStepId);
            const ep = s.egressPayloadId ? ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("agiPayloadId", s.egressPayloadId).one() : null;
            const ip = s.ingressPayloadId ? ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("agiPayloadId", s.ingressPayloadId).one() : null;

            nodes.push({
                stageId: sId,
                pipelineStepId: sId,
                parentStageId: s.parentStepId ? String(s.parentStepId) : null,
                parentStepId: s.parentStepId ? String(s.parentStepId) : null,
                discussionId: String(s.discussionId),
                stepSequenceNum: Number(s.stepSequenceNum) || 1,
                actionType: stanceToMode(s.stanceEnumId),
                statusId: s.statusId,
                isArchived: s.statusId === "PlsArchived",
                label: s.stepLabel || ("Step #" + sId),
                directivePrompt: s.directivePrompt || "",
                ingressPayloadId: s.ingressPayloadId ? String(s.ingressPayloadId) : null,
                egressPayloadId: s.egressPayloadId ? String(s.egressPayloadId) : null,
                ingressJsonData: ip ? ip.payloadJsonData : null,
                egressJsonData: ep ? ep.payloadJsonData : null,
                fullText: (ep && ep.payloadJsonData) ? ep.payloadJsonData : (s.directivePrompt || ""),
                targetArtifactUri: s.targetArtifactUri || "",
                entryDate: s.createdDate ? String(s.createdDate) : ""
            });
        }

        for (const assoc of assocList) {
            const key = assoc.fromPipelineStepId + "->" + assoc.toPipelineStepId;
            if (!addedEdges.has(key)) {
                addedEdges.add(key);
                edges.push({
                    edgeId: key,
                    from: String(assoc.fromPipelineStepId),
                    to: String(assoc.toPipelineStepId),
                    label: assoc.assocTypeEnumId === "ApsaMerge" ? "merge" : "feeds"
                });
            }
        }

        for (const s of steps) {
            if (s.parentStepId) {
                const key = s.parentStepId + "->" + s.pipelineStepId;
                if (!addedEdges.has(key)) {
                    addedEdges.add(key);
                    edges.push({ edgeId: key, from: String(s.parentStepId), to: String(s.pipelineStepId), label: "feeds" });
                }
            }
        }
    }

    context.pipelineNodes = nodes;
    context.pipelineEdges = edges;
}

function createDiscussion(context) {
    const ec = context.ec;
    const disc = ec.entity.makeValue("org.moqui.ai.discussion.AgiDiscussion");
    disc.name = context.name;
    disc.shortName = context.shortName || String(context.name || "").slice(0, 20);
    disc.targetComponent = context.targetComponent || null;
    disc.targetArtifactUri = context.targetArtifactUri || null;
    disc.discussionCategoryEnumId = context.discussionCategoryEnumId || "AitCategoryInstance";
    disc.discussionTypeEnumId = context.discussionTypeEnumId || "AitDiscElicitation";
    disc.statusId = "AgdStatusActive";
    disc.fromDate = ec.user.nowTimestamp;
    disc.messageCount = 0;
    disc.setSequencedIdPrimary();
    disc.create();

    context.discussionId = String(disc.discussionId);
}

function updateDiscussionTitle(context) {
    const ec = context.ec;
    const dId = String(context.discussionId || "").trim();
    const disc = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", dId).one();
    if (!disc) { ec.message.addError("Discussion #" + dId + " not found."); return; }

    const cleanTitle = String(context.name || "").trim() || ("Pipeline #" + dId);
    disc.name = cleanTitle;
    disc.shortName = cleanTitle.slice(0, 30);
    disc.lastActivityDate = ec.user.nowTimestamp;
    disc.update();

    context.discussionId = dId;
    context.name = disc.name;
    context.shortName = disc.shortName;
}

function deleteDiscussion(context) {
    const ec = context.ec;
    const dId = String(context.discussionId || "").trim();
    if (!dId) { context.success = false; context.message = "Missing discussionId."; return; }

    const payloads = Array.from(ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("discussionId", dId).list());
    const payloadIds = payloads.map(p => p.agiPayloadId);
    for (const p of payloads) {
        if (p.parentPayloadId) { p.parentPayloadId = null; p.update(); }
    }

    const steps = Array.from(ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("discussionId", dId).list());
    const stepIds = steps.map(s => s.pipelineStepId);
    if (stepIds.length > 0) {
        ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStepAssoc").condition("fromPipelineStepId", "in", stepIds).deleteAll();
        ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStepAssoc").condition("toPipelineStepId", "in", stepIds).deleteAll();
    }
    for (const s of steps) {
        s.parentStepId = null; s.ingressPayloadId = null; s.egressPayloadId = null;
        s.assistantMessageId = null; s.userMessageId = null; s.update();
    }

    const msgs = Array.from(ec.entity.find("org.moqui.ai.discussion.AgiMessage").condition("discussionId", dId).list());
    const msgIds = msgs.map(m => m.messageId);
    for (const m of msgs) {
        m.parentMessageId = null; m.stagedPayloadId = null; m.update();
    }

    if (payloadIds.length > 0) ec.entity.find("org.moqui.ai.payload.AgiPayloadFacet").condition("agiPayloadId", "in", payloadIds).deleteAll();
    if (msgIds.length > 0) {
        ec.entity.find("org.moqui.ai.discussion.AgiMessageContent").condition("messageId", "in", msgIds).deleteAll();
        ec.entity.find("org.moqui.ai.discussion.AgiMessageFacet").condition("messageId", "in", msgIds).deleteAll();
    }
    ec.entity.find("org.moqui.ai.discussion.AgiDiscussionFacet").condition("discussionId", dId).deleteAll();
    ec.entity.find("org.moqui.ai.discussion.AgiDiscussionRelationship").condition("parentDiscussionId", dId).deleteAll();
    ec.entity.find("org.moqui.ai.discussion.AgiDiscussionRelationship").condition("childDiscussionId", dId).deleteAll();

    ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("discussionId", dId).deleteAll();
    for (const p of payloads) p.delete();
    ec.entity.find("org.moqui.ai.discussion.AgiMessage").condition("discussionId", dId).deleteAll();
    ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", dId).deleteAll();

    context.success = true;
    context.message = "Discussion " + dId + " deleted.";
}

function getPayload(context) {
    const ec = context.ec;
    const pld = ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("agiPayloadId", context.agiPayloadId).one();
    if (!pld) { ec.message.addError("AgiPayload not found: " + context.agiPayloadId); return; }

    const outMap = Object.assign({}, pld.getMap());
    if (pld.payloadJsonData) {
        try { outMap.payload = JSON.parse(pld.payloadJsonData); } catch (e) { }
    }
    if (pld.executionResultJson) {
        try { outMap.executionResult = JSON.parse(pld.executionResultJson); } catch (e) { }
    }
    context.payloadDetails = outMap;
}

function processPayload(context) {
    const ec = context.ec;
    const modeEnumId = normalizeStance(context.mode);
    const pld = context.agiPayloadId
        ? ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("agiPayloadId", context.agiPayloadId).one()
        : null;
    const target = pld || ec.entity.makeValue("org.moqui.ai.payload.AgiPayload");
    if (!pld) {
        target.setSequencedIdPrimary();
        target.createdDate = ec.user.nowTimestamp;
        target.statusId = "PlsDraft";
    } else {
        target.revisionNumber = (Number(target.revisionNumber) || 1) + 1;
    }
    target.modeEnumId = modeEnumId;
    target.targetComponent = context.targetComponent || "";
    target.artifactUri = context.artifactUri || null;
    target.title = context.title || "Payload";
    target.userPromptText = context.userPromptText || null;
    target.payloadJsonData = context.payload ? JSON.stringify(context.payload) : target.payloadJsonData;
    target.createOrUpdate();

    context.agiPayloadId = String(target.agiPayloadId);
    context.statusId = String(target.statusId);
}

function forkPipelineStep(context) {
    const ec = context.ec;
    let srcStep = context.sourceStepId
        ? ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("pipelineStepId", context.sourceStepId).one()
        : null;

    const discId = srcStep ? String(srcStep.discussionId) : (context.discussionId ? String(context.discussionId) : null);
    if (!discId) { ec.message.addError("Either sourceStepId or discussionId is required"); return; }

    if (!srcStep) {
        srcStep = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep")
            .condition("discussionId", discId).orderBy("-stepSequenceNum").limit(1).one();
    }
    if (!srcStep) {
        const discRec = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", discId).one();
        const comp = (discRec && discRec.targetComponent) || "";
        srcStep = ec.entity.makeValue("org.moqui.ai.pipeline.AgiPipelineStep");
        srcStep.discussionId = discId;
        srcStep.parentStepId = null;
        srcStep.stepSequenceNum = 1;
        srcStep.stanceEnumId = "AamDiscuss";
        srcStep.statusId = "PlsCommitted";
        srcStep.stepLabel = "Initiative Root";
        srcStep.directivePrompt = "Initial discussion root for " + comp;
        srcStep.targetArtifactUri = discRec ? discRec.targetArtifactUri : null;
        srcStep.createdDate = ec.user.nowTimestamp;
        srcStep.setSequencedIdPrimary();
        srcStep.create();
    }

    const effectiveStance = normalizeStance(context.targetStanceEnumId || context.stanceEnumId || srcStep.stanceEnumId);
    let activeIngressId = context.ingressPayloadId || srcStep.ingressPayloadId || null;

    if (context.modifiedPayloadJson && String(context.modifiedPayloadJson).trim()) {
        const srcPayload = activeIngressId
            ? ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("agiPayloadId", activeIngressId).one()
            : null;
        const parentDisc = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", discId).one();
        const cloned = ec.entity.makeValue("org.moqui.ai.payload.AgiPayload");
        cloned.modeEnumId = effectiveStance;
        cloned.statusId = "PlsDraft";
        cloned.targetComponent = (srcPayload && srcPayload.targetComponent)
            || (srcStep && srcStep.targetComponent)
            || (parentDisc && parentDisc.targetComponent)
            || "";
        cloned.artifactUri = srcStep.targetArtifactUri || null;
        cloned.discussionId = discId;
        cloned.title = "Ingress for Step from #" + srcStep.pipelineStepId;
        cloned.userPromptText = context.directivePrompt || srcStep.directivePrompt;
        cloned.payloadJsonData = String(context.modifiedPayloadJson).trim();
        cloned.parentPayloadId = activeIngressId;
        cloned.createdDate = ec.user.nowTimestamp;
        cloned.setSequencedIdPrimary();
        cloned.create();
        activeIngressId = String(cloned.agiPayloadId);
    }

    const nextSeq = (Number(srcStep.stepSequenceNum) || 1) + 1;
    const isSuccessor = !!context.ingressPayloadId && String(context.ingressPayloadId) === String(srcStep.egressPayloadId);

    const forked = ec.entity.makeValue("org.moqui.ai.pipeline.AgiPipelineStep");
    forked.discussionId = discId;
    forked.parentStepId = isSuccessor ? String(srcStep.pipelineStepId) : (srcStep.parentStepId || null);
    forked.stepSequenceNum = nextSeq;
    forked.stanceEnumId = effectiveStance;
    forked.statusId = "PlsDraft";
    forked.stepLabel = (isSuccessor ? stanceToMode(effectiveStance).toUpperCase() + " from #" : "Alt from #") + srcStep.pipelineStepId;
    forked.ingressPayloadId = activeIngressId;
    forked.directivePrompt = context.directivePrompt || srcStep.directivePrompt;
    forked.egressPayloadId = null;
    forked.targetArtifactUri = srcStep.targetArtifactUri || null;
    forked.createdDate = ec.user.nowTimestamp;
    forked.setSequencedIdPrimary();
    forked.create();

    context.newStepId = String(forked.pipelineStepId);
    context.ingressPayloadId = activeIngressId;
    context.statusId = "PlsDraft";
}

function archivePipelineBranch(context) {
    const ec = context.ec;
    let count = 0;
    function walk(stepId) {
        const step = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("pipelineStepId", stepId).one();
        if (step && step.statusId !== "PlsArchived") {
            step.statusId = "PlsArchived";
            step.lastUpdatedDate = ec.user.nowTimestamp;
            step.update();
            count++;
            const children = Array.from(ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("parentStepId", stepId).list());
            for (const ch of children) walk(String(ch.pipelineStepId));
        }
    }
    walk(String(context.pipelineStepId));
    context.archivedCount = count;
}

function orchestrateModule(context) {
    const ec = context.ec;
    const srcStep = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep")
        .condition("pipelineStepId", context.sourceStepId).one();
    if (!srcStep) { ec.message.addError("Source Step " + context.sourceStepId + " not found"); return; }

    const activeIngressId = srcStep.egressPayloadId || srcStep.ingressPayloadId;
    const spawnedIds = [];
    const subplans = Array.isArray(context.subplans) ? context.subplans : [];

    subplans.forEach((sub, idx) => {
        const title = sub.title || sub.name || ("Sub-Screen " + (idx + 1));
        const key = sub.key || ("sub_" + (idx + 1));
        const archetype = sub.suggestedArchetype || sub.archetype || "master-detail";
        const baseUri = String(srcStep.targetArtifactUri || "").replace(/\.xml$/, "");
        const targetUri = sub.targetArtifactUri || (baseUri ? (baseUri + "/" + title.replace(/\s+/g, "") + ".xml") : "");

        const directive = sub.directivePrompt || (
            "Orchestrate canonical implementation plan for '" + title + "' (" + key + ") subscreen.\n\n" +
            "Target Screen: " + targetUri + "\nArchetype: " + archetype + "\n" +
            (sub.description ? "Scope: " + sub.description + "\n" : "")
        );

        const res = ec.service.sync().name("org.moqui.ai.pipeline.AgiPipelineServices.fork#PipelineStep").parameters({
            sourceStepId: String(srcStep.pipelineStepId),
            targetStanceEnumId: context.targetStanceEnumId || "AamPlan",
            ingressPayloadId: activeIngressId,
            directivePrompt: directive
        }).call();

        if (res && res.newStepId) {
            spawnedIds.push(String(res.newStepId));
            const stepVal = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("pipelineStepId", res.newStepId).one();
            if (stepVal) {
                stepVal.stepLabel = "Plan: " + title;
                if (targetUri) stepVal.targetArtifactUri = targetUri;
                stepVal.update();
            }
        }
    });

    context.spawnedStepIds = spawnedIds;
    context.spawnedCount = spawnedIds.length;
}

function updatePipelineStepArtifact(context) {
    const ec = context.ec;
    const step = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("pipelineStepId", context.pipelineStepId).one();
    if (step) {
        step.targetArtifactUri = context.targetArtifactUri;
        step.update();
    }
}

function promotePipelineStepToDiscussion(context) {
    const ec = context.ec;
    const step = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("pipelineStepId", context.pipelineStepId).one();
    if (!step) { ec.message.addError("Pipeline step #" + context.pipelineStepId + " not found."); return; }

    const oldDisc = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", step.discussionId).one();
    const title = context.discussionName || step.stepLabel || ("Extracted: Step #" + step.pipelineStepId);

    const newDisc = ec.entity.makeValue("org.moqui.ai.discussion.AgiDiscussion");
    newDisc.name = title;
    newDisc.shortName = title.slice(0, 30);
    newDisc.targetComponent = (oldDisc && oldDisc.targetComponent) || null;
    newDisc.targetArtifactUri = step.targetArtifactUri || (oldDisc && oldDisc.targetArtifactUri) || null;
    newDisc.statusId = "AgdStatusActive";
    newDisc.fromDate = ec.user.nowTimestamp;
    newDisc.messageCount = 1;
    newDisc.setSequencedIdPrimary();
    newDisc.create();

    const newDiscId = String(newDisc.discussionId);
    step.discussionId = newDiscId;
    step.parentStepId = null;
    step.stepSequenceNum = 1;
    step.update();

    context.newDiscussionId = newDiscId;
    context.migratedStepCount = 1;
}

function getOrEnsureDiscussionDraftPayload(context) {
    const ec = context.ec;
    const disc = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", context.discussionId).one();
    const comp = (disc && disc.targetComponent) || context.targetComponent || "";
    const filePath = comp ? ("component://" + comp + "/prompt/component.md") : "";

    let rootPayload = ec.entity.find("org.moqui.ai.payload.AgiPayload")
        .condition("discussionId", context.discussionId)
        .condition("messageId", null)
        .condition("statusId", "PlsDraft")
        .one();

    if (!rootPayload) {
        const initialText = "# Architecture Directives: " + (comp || "COMPONENT").toUpperCase() + "\n\n## 1. Domain Scope\n- Operational workflows for " + (comp || "target component") + ".\n";
        rootPayload = ec.entity.makeValue("org.moqui.ai.payload.AgiPayload");
        rootPayload.discussionId = context.discussionId;
        rootPayload.messageId = null;
        rootPayload.targetComponent = comp;
        rootPayload.modeEnumId = "AamDiscuss";
        rootPayload.statusId = "PlsDraft";
        rootPayload.title = "Directives Working Buffer: " + comp;
        rootPayload.userPromptText = initialText;
        rootPayload.createdDate = ec.user.nowTimestamp;
        rootPayload.setSequencedIdPrimary();
        rootPayload.create();
    }

    context.agiPayloadId = String(rootPayload.agiPayloadId);
    context.userPromptText = rootPayload.userPromptText || "";
    context.targetComponent = comp;
    context.filePath = filePath;
}

function pinTurnToDirectives(context) {
    const ec = context.ec;
    const ensureRes = ec.service.sync().name("org.moqui.ai.pipeline.AgiPipelineServices.getOrEnsure#DiscussionDraftPayload").parameters({
        discussionId: context.discussionId
    }).call();

    const rootPayload = ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("agiPayloadId", ensureRes.agiPayloadId).one();
    const contentToPin = String(context.pinnedContent || "").trim();
    const title = context.pinnedTitle || ("Consensus from Step #" + context.messageId);

    const updated = ((rootPayload && rootPayload.userPromptText) ? rootPayload.userPromptText.trim() + "\n\n" : "") +
        "### " + title + "\n" + contentToPin + "\n";

    if (rootPayload) {
        rootPayload.userPromptText = updated;
        rootPayload.update();
    }

    context.rootPayloadId = ensureRes.agiPayloadId;
    context.updatedDirectivesText = updated;
}

function saveDiscussionDirectives(context) {
    const ec = context.ec;
    const ensureRes = ec.service.sync().name("org.moqui.ai.pipeline.AgiPipelineServices.getOrEnsure#DiscussionDraftPayload").parameters({
        discussionId: context.discussionId,
        targetComponent: context.targetComponent
    }).call();

    const rootPayload = ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("agiPayloadId", ensureRes.agiPayloadId).one();
    if (rootPayload) {
        rootPayload.userPromptText = context.directivesText;
        rootPayload.update();
    }

    context.agiPayloadId = ensureRes.agiPayloadId;
    context.status = "SUCCESS";
}

function recordAndDispatchPipelineStep(context) {
    const ec = context.ec;
    const discId = String(context.discussionId);
    const disc = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", discId).one();
    if (!disc) { ec.message.addError("Discussion #" + discId + " not found."); return; }

    const comp = disc.targetComponent || "";
    const normalizedStance = normalizeStance(context.stanceEnumId);
    const modeCode = stanceToMode(normalizedStance);

    let currentStep = context.pipelineStepId
        ? ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("pipelineStepId", String(context.pipelineStepId).trim()).one()
        : null;

    if (currentStep) {
        currentStep.statusId = "PlsExecuting";
        currentStep.stanceEnumId = normalizedStance;
        if (context.directivePrompt) currentStep.directivePrompt = context.directivePrompt;
        if (context.stepLabel) currentStep.stepLabel = context.stepLabel;
        if (context.ingressPayloadId) currentStep.ingressPayloadId = context.ingressPayloadId;
        if (context.targetArtifactUri) currentStep.targetArtifactUri = context.targetArtifactUri;
        currentStep.lastUpdatedDate = ec.user.nowTimestamp;
        currentStep.update();
    } else {
        const lastStep = ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep")
            .condition("discussionId", discId).orderBy("-stepSequenceNum").limit(1).one();
        const nextSeq = lastStep ? ((Number(lastStep.stepSequenceNum) || 0) + 1) : 1;

        currentStep = ec.entity.makeValue("org.moqui.ai.pipeline.AgiPipelineStep");
        currentStep.discussionId = discId;
        currentStep.parentStepId = context.parentStepId || null;
        currentStep.stepSequenceNum = nextSeq;
        currentStep.stanceEnumId = normalizedStance;
        currentStep.statusId = "PlsExecuting";
        currentStep.stepLabel = context.stepLabel || String(context.directivePrompt || "Directive").slice(0, 50);
        currentStep.ingressPayloadId = context.ingressPayloadId || null;
        currentStep.directivePrompt = context.directivePrompt;
        currentStep.targetArtifactUri = context.targetArtifactUri || disc.targetArtifactUri || null;
        currentStep.createdDate = ec.user.nowTimestamp;
        currentStep.setSequencedIdPrimary();
        currentStep.create();
    }

    const targetStepId = String(currentStep.pipelineStepId);
    context.pipelineStepId = targetStepId;

    const userMsgId = recordTurn(ec, {
        discussionId: discId,
        senderRoleEnumId: "AsrUser",
        content: context.directivePrompt,
        title: "Directive #" + targetStepId,
        targetArtifactUri: currentStep.targetArtifactUri
    });
    currentStep.userMessageId = userMsgId;
    currentStep.update();

    // Hydrate upstream Ingress JSON if present
    let upstreamContext = "";
    const resolvedIngressId = currentStep.ingressPayloadId;
    if (resolvedIngressId) {
        const ing = ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("agiPayloadId", resolvedIngressId).one();
        if (ing && ing.payloadJsonData) {
            upstreamContext = "\n\n### Upstream Context Contract (Payload #" + resolvedIngressId + "):\n" + ing.payloadJsonData;
        }
    }

    const contractGuide = modeCode === "discuss"
        ? "Return valid JSON with keys: status ('DISCUSSING' or 'READY_TO_ORCHESTRATE'), scopeMaturity ('EXPLORATORY' or 'MATURE'), readyToOrchestrate (boolean), replyMessage (markdown), proposedModules ([{key, title, description, suggestedArchetype}]), clarifyingQuestions ([string]), architecturalConsiderations ([string])."
        : (modeCode === "plan"
            ? "Return valid JSON with keys: status ('PLANNED'), recommendedArchetype, targetArtifactUri, suggestedEntities ([string]), screenContract ({requiredPermissions, requiredParameters, transitions}), entityFieldBindings ([{entityName, fieldName, encrypt}]), securityAndHipaaRules ([string]), architectureSummary, formulationSteps ([string])."
            : "Return valid JSON with keys: status ('SUCCESS'), targetArtifactUri, rawXmlContent (complete valid Moqui XML screen), message.");

    const fullPrompt = contractGuide + "\n\nComponent: " + comp + "\nTarget Artifact: " + (currentStep.targetArtifactUri || "component scope") +
        "\nDirective:\n" + context.directivePrompt + upstreamContext;

    let agentText = "";
    try {
        const aiRes = ec.service.sync().name("org.moqui.agent.AiTaskServices.run#Generate").parameters({
            prompt: fullPrompt,
            allowInTransaction: true
        }).call();
        agentText = (aiRes && (aiRes.text || aiRes.output || aiRes.result)) ? String(aiRes.text || aiRes.output || aiRes.result) : "";
    } catch (err) {
        agentText = JSON.stringify({
            status: "error",
            errorCode: "LLM_CALL_FAILED",
            message: String(err.message || err)
        });
    }

    const isFailed = !agentText || agentText.indexOf('"status":"error"') !== -1;
    const asstMsgId = recordTurn(ec, {
        discussionId: discId,
        parentMessageId: userMsgId,
        senderRoleEnumId: "AsrAssistant",
        content: agentText,
        title: modeCode.toUpperCase() + " Output #" + targetStepId,
        targetArtifactUri: currentStep.targetArtifactUri
    });

    if (isFailed) {
        currentStep.assistantMessageId = asstMsgId;
        currentStep.statusId = "PlsFailed";
        currentStep.lastUpdatedDate = ec.user.nowTimestamp;
        currentStep.update();
        context.statusId = "PlsFailed";
        context.completionText = agentText;
        return;
    }

    const egress = ec.entity.makeValue("org.moqui.ai.payload.AgiPayload");
    egress.modeEnumId = normalizedStance;
    egress.statusId = "PlsCommitted";
    egress.targetComponent = comp;
    egress.artifactUri = currentStep.targetArtifactUri || null;
    egress.discussionId = discId;
    egress.messageId = asstMsgId;
    egress.title = "Step #" + targetStepId + " Egress";
    egress.userPromptText = context.directivePrompt;
    egress.payloadJsonData = agentText;
    egress.createdDate = ec.user.nowTimestamp;
    egress.setSequencedIdPrimary();
    egress.create();

    currentStep.assistantMessageId = asstMsgId;
    currentStep.egressPayloadId = String(egress.agiPayloadId);
    currentStep.statusId = "PlsCommitted";
    currentStep.lastUpdatedDate = ec.user.nowTimestamp;
    currentStep.update();

    context.egressPayloadId = String(egress.agiPayloadId);
    context.assistantMessageId = asstMsgId;
    context.completionText = agentText;
    context.statusId = "PlsCommitted";
}