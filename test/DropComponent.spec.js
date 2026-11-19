// Regression spec for org.moqui.ai.ComponentServices.drop#Component and POST /rest/s1/agi-ai/component/drop.
// Run: ./moq test agi-aide --spec DropComponent --nobuild

function callDropProbe(componentName) {
    ec.message.pushErrors();
    let result = null;
    try {
        result = ec.service.sync()
            .name("org.moqui.ai.ComponentServices.drop#Component")
            .parameters({ componentName })
            .requireNewTransaction(true)
            .call();
        const errors = Array.from(ec.message.errors || []);
        ec.message.clearErrors();
        return { result, errors };
    } finally {
        ec.message.popErrors();
    }
}

feature("drop#Component blocks protected system components and invalid names", {
    when() {
        const protectedNames = [
            "agi-aide", "dev-aide", "moqui-usl", "mantle-usl",
            "webroot", "tools", "system", "AGI-AIDE"
        ];
        const invalidNames = ["../escape", "bad/name", "has space", "123start"];
        const failures = [];
        for (const name of protectedNames.concat(invalidNames)) {
            const { result, errors } = callDropProbe(name);
            if (!errors.length || (result && result.success === true)) {
                failures.push(name + " was not blocked");
            }
        }
        return { failures };
    },
    then({ failures }) {
        failures.join("; ") == ""
    }
});

feature("POST /rest/s1/agi-ai/component/drop resolves to drop#Component", {
    when() {
        const resolved = ec.service.restApi.resolveService("agi-ai/component/drop", "POST");
        return { serviceName: resolved ? resolved.serviceName : "" };
    },
    then({ serviceName }) {
        serviceName == "org.moqui.ai.ComponentServices.drop#Component"
    }
});

feature("drop#Component purges all AGI records in FK-safe order, deletes directory, and clears caches", {
    when() {
        const comp = "drop-test-app";
        const otherComp = "keep-other-app";
        const compRoot = "runtime://components/addon";
        const compLoc = compRoot + "/" + comp;

        // Clean any leftover test directory first
        const existingRef = ec.resource.getLocationReference(compLoc);
        if (existingRef && existingRef.exists) {
            ec.resource.makeChangeSet(compRoot).delete(comp).commit("Pre-test cleanup");
        }

        // Create component directory with nested files on disk under runtime/components/addon/
        ec.resource.putContent(compLoc + "/component.xml", "<component name=\"" + comp + "\"/>", "test");
        ec.resource.putContent(compLoc + "/prompt/component.md", "# Test directives\n", "test");
        const existedBefore = ec.resource.getLocationReference(compLoc).exists;

        // Seed complete relational graph covering all AGI entities with self-refs & cross-refs
        const already = ec.artifactExecution.disableAuthz();
        let d1Id, d2Id, otherDiscId, m1Id, m2Id, p1Id, p2Id, pStandaloneId, s1Id, s2Id;
        try {
            const d1 = ec.entity.makeValue("org.moqui.ai.discussion.AgiDiscussion");
            d1.name = "Primary Discussion";
            d1.targetComponent = comp;
            d1.setSequencedIdPrimary();
            d1.create();
            d1Id = String(d1.discussionId);

            const d2 = ec.entity.makeValue("org.moqui.ai.discussion.AgiDiscussion");
            d2.name = "Child Discussion";
            d2.targetComponent = comp;
            d2.setSequencedIdPrimary();
            d2.create();
            d2Id = String(d2.discussionId);

            const otherDisc = ec.entity.makeValue("org.moqui.ai.discussion.AgiDiscussion");
            otherDisc.name = "Control Discussion";
            otherDisc.targetComponent = otherComp;
            otherDisc.setSequencedIdPrimary();
            otherDisc.create();
            otherDiscId = String(otherDisc.discussionId);

            const rel = ec.entity.makeValue("org.moqui.ai.discussion.AgiDiscussionRelationship");
            rel.parentDiscussionId = d1Id;
            rel.childDiscussionId = d2Id;
            rel.setSequencedIdPrimary();
            rel.create();

            const df = ec.entity.makeValue("org.moqui.ai.discussion.AgiDiscussionFacet");
            df.discussionId = d1Id;
            df.facetKey = "compliance";
            df.facetValue = "hipaa";
            df.setSequencedIdPrimary();
            df.create();

            const m1 = ec.entity.makeValue("org.moqui.ai.discussion.AgiMessage");
            m1.discussionId = d1Id;
            m1.senderRoleEnumId = "AsrUser";
            m1.setSequencedIdPrimary();
            m1.create();
            m1Id = String(m1.messageId);

            const m2 = ec.entity.makeValue("org.moqui.ai.discussion.AgiMessage");
            m2.discussionId = d1Id;
            m2.parentMessageId = m1Id;
            m2.senderRoleEnumId = "AsrAssistant";
            m2.setSequencedIdPrimary();
            m2.create();
            m2Id = String(m2.messageId);

            const mc = ec.entity.makeValue("org.moqui.ai.discussion.AgiMessageContent");
            mc.messageId = m1Id;
            mc.contentSeqId = "1";
            mc.contentTypeEnumId = "mctMarkdown";
            mc.bodyText = "Hello world";
            mc.create();

            const mf = ec.entity.makeValue("org.moqui.ai.discussion.AgiMessageFacet");
            mf.messageId = m2Id;
            mf.facetKey = "domain";
            mf.facetValue = "clinical";
            mf.setSequencedIdPrimary();
            mf.create();

            const p1 = ec.entity.makeValue("org.moqui.ai.payload.AgiPayload");
            p1.modeEnumId = "AamDiscuss";
            p1.targetComponent = comp;
            p1.discussionId = d1Id;
            p1.messageId = m1Id;
            p1.title = "Root Payload";
            p1.setSequencedIdPrimary();
            p1.create();
            p1Id = String(p1.agiPayloadId);

            const p2 = ec.entity.makeValue("org.moqui.ai.payload.AgiPayload");
            p2.modeEnumId = "AamPlan";
            p2.targetComponent = comp;
            p2.discussionId = d1Id;
            p2.messageId = m2Id;
            p2.parentPayloadId = p1Id;
            p2.title = "Child Payload";
            p2.setSequencedIdPrimary();
            p2.create();
            p2Id = String(p2.agiPayloadId);

            const pStandalone = ec.entity.makeValue("org.moqui.ai.payload.AgiPayload");
            pStandalone.modeEnumId = "AamBuild";
            pStandalone.targetComponent = comp;
            pStandalone.title = "Standalone Payload";
            pStandalone.setSequencedIdPrimary();
            pStandalone.create();
            pStandaloneId = String(pStandalone.agiPayloadId);

            const pf = ec.entity.makeValue("org.moqui.ai.payload.AgiPayloadFacet");
            pf.agiPayloadId = p1Id;
            pf.facetKey = "archetype";
            pf.facetValue = "master-detail";
            pf.setSequencedIdPrimary();
            pf.create();

            const s1 = ec.entity.makeValue("org.moqui.ai.pipeline.AgiPipelineStep");
            s1.discussionId = d1Id;
            s1.stanceEnumId = "AamDiscuss";
            s1.ingressPayloadId = p1Id;
            s1.egressPayloadId = p2Id;
            s1.setSequencedIdPrimary();
            s1.create();
            s1Id = String(s1.pipelineStepId);

            const s2 = ec.entity.makeValue("org.moqui.ai.pipeline.AgiPipelineStep");
            s2.discussionId = d1Id;
            s2.parentStepId = s1Id;
            s2.stanceEnumId = "AamPlan";
            s2.ingressPayloadId = p2Id;
            s2.setSequencedIdPrimary();
            s2.create();
            s2Id = String(s2.pipelineStepId);

            const assoc = ec.entity.makeValue("org.moqui.ai.pipeline.AgiPipelineStepAssoc");
            assoc.fromPipelineStepId = s1Id;
            assoc.toPipelineStepId = s2Id;
            assoc.assocTypeEnumId = "ApsaFeeds";
            assoc.setSequencedIdPrimary();
            assoc.create();
        } finally {
            if (!already) ec.artifactExecution.enableAuthz();
        }

        // Put a sentinel value in a cache to verify caches are cleared
        const testCache = ec.cache.getCache("resource.dropComponentTest");
        testCache.put("sentinel", "present");

        const out = ec.service.sync()
            .name("org.moqui.ai.ComponentServices.drop#Component")
            .parameters({ componentName: comp })
            .call();

        const hasError = ec.message.hasError();
        const existsAfter = ec.resource.getLocationReference(compLoc).exists;
        const cacheEntryAfter = testCache.get("sentinel");

        const alreadyCheck = ec.artifactExecution.disableAuthz();
        let remaining = {};
        let otherStillExists = false;
        try {
            remaining = {
                discussions: ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("targetComponent", comp).count(),
                discussionFacets: ec.entity.find("org.moqui.ai.discussion.AgiDiscussionFacet").condition("discussionId", "in", [d1Id, d2Id]).count(),
                discussionRels: ec.entity.find("org.moqui.ai.discussion.AgiDiscussionRelationship").condition("parentDiscussionId", d1Id).count(),
                messages: ec.entity.find("org.moqui.ai.discussion.AgiMessage").condition("discussionId", "in", [d1Id, d2Id]).count(),
                messageContents: ec.entity.find("org.moqui.ai.discussion.AgiMessageContent").condition("messageId", "in", [m1Id, m2Id]).count(),
                messageFacets: ec.entity.find("org.moqui.ai.discussion.AgiMessageFacet").condition("messageId", "in", [m1Id, m2Id]).count(),
                payloads: ec.entity.find("org.moqui.ai.payload.AgiPayload").condition("targetComponent", comp).count(),
                payloadFacets: ec.entity.find("org.moqui.ai.payload.AgiPayloadFacet").condition("agiPayloadId", "in", [p1Id, p2Id, pStandaloneId]).count(),
                steps: ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStep").condition("discussionId", "in", [d1Id, d2Id]).count(),
                stepAssocs: ec.entity.find("org.moqui.ai.pipeline.AgiPipelineStepAssoc").condition("fromPipelineStepId", s1Id).count()
            };
            otherStillExists = ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", otherDiscId).one() != null;
            // Clean up control record
            ec.entity.find("org.moqui.ai.discussion.AgiDiscussion").condition("discussionId", otherDiscId).deleteAll();
        } finally {
            if (!alreadyCheck) ec.artifactExecution.enableAuthz();
        }

        const totalRemaining = Object.values(remaining).reduce((sum, n) => sum + Number(n || 0), 0);
        return {
            hasError,
            success: out && out.success,
            directoryDeleted: out && out.directoryDeleted,
            cachesCleared: out && out.cachesCleared,
            existedBefore,
            existsAfter,
            cacheEntryAfter,
            totalRemaining,
            otherStillExists,
            deletedRecords: out && out.deletedRecords
        };
    },
    then({
        hasError,
        success,
        directoryDeleted,
        cachesCleared,
        existedBefore,
        existsAfter,
        cacheEntryAfter,
        totalRemaining,
        otherStillExists,
        deletedRecords
    }) {
        hasError == false
        success == true
        directoryDeleted == true
        cachesCleared == true
        existedBefore == true
        existsAfter == false
        cacheEntryAfter == null
        totalRemaining == 0
        otherStillExists == true
        deletedRecords.AgiDiscussion == 2
        deletedRecords.AgiDiscussionRelationship == 1
        deletedRecords.AgiDiscussionFacet == 1
        deletedRecords.AgiMessage == 2
        deletedRecords.AgiMessageContent == 1
        deletedRecords.AgiMessageFacet == 1
        deletedRecords.AgiPayload == 3
        deletedRecords.AgiPayloadFacet == 1
        deletedRecords.AgiPipelineStep == 2
        deletedRecords.AgiPipelineStepAssoc == 1
    }
});

feature("GET /rest/s1/agi-ai/component/list resolves and discovers non-protected user components", {
    when() {
        const resolved = ec.service.restApi.resolveService("agi-ai/component/list", "GET");
        const comp = "list-test-app";
        const compRoot = "runtime://components/addon";
        const compLoc = compRoot + "/" + comp;

        if (ec.resource.getLocationReference(compLoc).exists) {
            ec.resource.makeChangeSet(compRoot).delete(comp).commit("Pre-test cleanup");
        }
        ec.resource.putContent(compLoc + "/component.xml", "<component name=\"" + comp + "\"/>", "test");

        const beforeDrop = ec.service.sync()
            .name("org.moqui.ai.ComponentServices.list#TargetComponents")
            .call();
        const namesBefore = Array.from((beforeDrop && beforeDrop.componentNames) || []);

        ec.service.sync()
            .name("org.moqui.ai.ComponentServices.drop#Component")
            .parameters({ componentName: comp })
            .call();

        const afterDrop = ec.service.sync()
            .name("org.moqui.ai.ComponentServices.list#TargetComponents")
            .call();
        const namesAfter = Array.from((afterDrop && afterDrop.componentNames) || []);

        const protectedPresent = ["agi-aide", "dev-aide", "webroot", "tools", "framework", "template"]
            .filter(name => namesBefore.includes(name));

        return {
            serviceName: resolved ? resolved.serviceName : "",
            foundBefore: namesBefore.includes(comp),
            foundAfter: namesAfter.includes(comp),
            protectedPresent: protectedPresent.join(",")
        };
    },
    then({ serviceName, foundBefore, foundAfter, protectedPresent }) {
        serviceName == "org.moqui.ai.ComponentServices.list#TargetComponents"
        foundBefore == true
        foundAfter == false
        protectedPresent == ""
    }
});
