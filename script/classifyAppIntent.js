// Pure ES2020+ JavaScript for MR-Moqui QuickJS Runtime
// Maps narrative intent to AGI domain archetypes and Dev AIDE gallery templates

const GALLERY_MAP = {
    "clinical-registry": "Record360",
    "huddle-ops": "Board",
    "facility-asset": "List",
    "service-case": "Wizard",
    "custom": "Landing"
};

const KEYWORDS = {
    "huddle-ops": ["huddle", "shift", "standup", "census", "acuity", "turnover", "nurse", "vitals"],
    "clinical-registry": ["patient", "resident", "care plan", "clinical", "diagnosis", "treatment", "medication", "mar", "chart"],
    "facility-asset": ["facility", "room", "bed", "equipment", "maintenance", "repair", "asset", "work order"],
    "service-case": ["intake", "case", "ticket", "request", "complaint", "incident", "billing", "workflow"]
};

const rawNarrative = (context.narrative || "").trim();
const text = rawNarrative.toLowerCase();

if (!text || text.length < 10) {
    ec.context.suggestedArchetype = "custom";
    ec.context.galleryArchetype = GALLERY_MAP["custom"];
    ec.context.confidence = 0.5;
} else {
    // 1. Instant Server Heuristic Scoring (Sub-millisecond)
    const scores = {
        "huddle-ops": 0,
        "clinical-registry": 0,
        "facility-asset": 0,
        "service-case": 0
    };

    for (const [archetype, words] of Object.entries(KEYWORDS)) {
        for (const kw of words) {
            if (text.includes(kw)) {
                scores[archetype] += 2;
            }
        }
    }

    let bestArchetype = "custom";
    let maxScore = 0;

    for (const [archetype, score] of Object.entries(scores)) {
        if (score > maxScore) {
            maxScore = score;
            bestArchetype = archetype;
        }
    }

    let finalArchetype = bestArchetype;
    let finalConfidence = maxScore > 0 ? 0.85 : 0.5;

    // 2. Optional AI Proxy Fast-Path (when useAi is true and AI proxy service is registered)
    if (context.useAi === true) {
        try {
            const systemPrompt = [
                "You are an application classifier. Given the narrative description, classify into EXACTLY ONE archetype:",
                "- huddle-ops (shifts, standups, handoffs, time-critical operational checklists)",
                "- clinical-registry (residents, patients, long-term logs, care plans, vitals)",
                "- facility-asset (work orders, maintenance, equipment, facility rooms)",
                "- service-case (intake tickets, case workflows, customer requests)",
                "- custom (none of the above)",
                'Return JSON ONLY: {"archetype": "id", "confidence": 0.95}'
            ].join("\n");

            const aiResult = ec.service.sync()
                .name("org.moqui.ai.AgiAiGatewayServices.run#OpenAiProxy")
                .parameters({
                    systemInstruction: systemPrompt,
                    userPrompt: rawNarrative,
                    mode: "classify",
                    aiProfileName: "local-qwen"
                })
                .call();

            const reply = (aiResult && aiResult.completionText) ? String(aiResult.completionText) : "";
            const jsonMatch = reply.match(/\{[\s\S]*?"archetype"\s*:\s*"([^"]+)"[\s\S]*?\}/);

            if (jsonMatch && jsonMatch[1]) {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.archetype && GALLERY_MAP[parsed.archetype]) {
                    finalArchetype = parsed.archetype;
                    finalConfidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.95;
                }
            }
        } catch (err) {
            ec.logger.warn(`[classify#AppIntent] AI proxy fallback to heuristic: ${err.message || err}`);
        }
    }

    ec.context.suggestedArchetype = finalArchetype;
    ec.context.galleryArchetype = GALLERY_MAP[finalArchetype] || "Landing";
    ec.context.confidence = finalConfidence;
}