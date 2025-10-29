const functions = require("firebase-functions");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// v2 (推薦): 導入並定義您的 Gemini API Key "密鑰"
// 我們需要在下一個步驟中設定這個密鑰
const { defineSecret } = require("firebase-functions/params");
const geminiApiKey = defineSecret("GEMINI_API_KEY");

// 初始化 Gemini AI
// 確保您的模型名稱與您的 API Key 權限相符
const MODEL_NAME = "gemini-2.5-flash-preview-09-2025";

/**
 * 這是您的核心雲端函式 (Callable Function)
 * 它可以從您的 App 被安全地呼叫
 */
exports.generateSoapNote = onCall({
    // 綁定我們即將設定的密鑰
    secrets: [geminiApiKey],
    // (選填) 設定區域，例如 'asia-east1' (台灣)
    // 這可以讓您的 App 在亞洲連線時速度更快
    region: 'asia-east1', 
}, async (request) => {

    // --- 1. 安全性檢查：檢查使用者是否登入 ---
    // 這是 Firebase Authentication 提供的功能
    if (!request.auth) {
        logger.warn("未經身份驗證的請求", { uid: null });
        throw new HttpsError(
            "unauthenticated",
            "您必須登入才能使用此功能。"
        );
    }

    // 使用者已登入，我們可以取得他的 UID
    const uid = request.auth.uid;
    logger.info(`已驗證來自 ${uid} 的請求。`);

    // --- 2. 取得 App 傳來的資料 ---
    // (request.data 就是從 App 傳來的 JSON 物 crít)
    const { 
        patientInfo, 
        specialtyFocus, 
        uptodateInfo, 
        micromedexInfo, 
        openevidenceInfo 
    } = request.data;

    // 確保 App 至少有傳送 'patientInfo'
    if (!patientInfo) {
        throw new HttpsError(
            "invalid-argument",
            "請求中缺少 'patientInfo' (病患核心資料)。"
        );
    }

    // --- 3. 初始化 Gemini (使用安全的密鑰) ---
    // .value() 會在伺服器上安全地讀取您設定的 API Key
    const genAI = new GoogleGenerativeAI(geminiApiKey.value());

    // (重要!) 啟用 Google 搜尋工具
    const model = genAI.getGenerativeModel({ 
        model: MODEL_NAME,
        tools: [{"google_search": {}}] // 啟用 Google Search
    });

    // --- 4. 組合 Prompt (與您 v15.4 的 HTML 版本完全相同) ---

    // 您的 System Prompt
    const systemPrompt = `您是一位頂尖的臨床藥師，擁有豐富的經驗，並且隨時掌握最新的國際醫療指引。

您的任務是 (v15.4)：
1.  仔細分析使用者在 [病患核心資料] 中提供的資訊 (病史、Lab、用藥等)。
2.  自動識別出最相關的主要病症。
3.  (最重要) **使用 Google 搜尋來查找並確認**該病症**「實際的最新指引版本和年份」**。
    * 例如：搜尋 "latest GINA guideline update", "current GOLD report version", "AHA hypertension guideline latest year"。
    * 您必須理解，指引**並非每年更新**。您的目標是找到那個「實際的」年份。
4.  (重要) **請分析**病患目前用藥清單中的**潛在藥物交互作用 (DDI)** 或**重複用藥 (Duplicate Therapy)**。您可以使用 Google 搜尋來輔助驗證。
5.  (v14.1) 如果使用者提供了 [專科焦點] (例如 "心臟內科")，您的評估應更側重於該領域。
6.  (v15.2) 使用者可能會在 [UpToDate 資料], [Micromedex 資料], [OpenEvidence 資料] 欄位提供補充資訊。
7.  (v15.2) 如果這些欄位「有內容」，您**必須**將這些重點整合到您的 (A) 或 (P) 中，並且**「明確註明來源」**(例如："根據 Micromedex 資料..." 或 "UpToDate 亦指出...")。如果欄位為空，則忽略。
8.  根據「SOAP」格式，撰寫一份專業、精確、格式化的藥師筆記草稿 (保留粗體和換行)。
9.  在您的「Assessment (A)」部分：
    * **(v14.1 強制)** **必須明確提及**您參考的指引名稱與**「實際年份」** (例如："根據 GINA 2024 指引...")。
    * **(v14.1 強制)** **必須引用**該指引中的**「精確原文句子」**來支持您的臨床決策 (例如："...GINA 2024 建議... (原文: '...')")。
    * **必須包含**您對 DDI 或重複用藥的評估。
    * **必須包含**對腎功能 (eGFR) 的考量與劑量評估。
10. 在您的「Plan (P)」部分：
    * 您的所有建議都必須**符合**您在 (A) 中提到的最新指引。

11. (*** v14 格式要求 ***)
    * 您的回覆**必須**嚴格遵守此格式：
    [完整的 SOAP 筆記 (S, O, A, P)]
    ---GUIDELINES_USED---
    * [指引 1 名稱] - [年份]
    * [指引 2 名稱] - [年份]
    * [其他參考的 DDI 資料庫或文獻]
    * (v15.2) [若有使用 UpToDate, 請註明]
    * (v15.2) [若有使用 Micromedex, 請註明]
    * (v15.2) [若有使用 OpenEvidence, 請註明]

12. (*** v14.4 格式禁止 ***)
    * **禁止**在您的回覆中使用任何 LaTeX 語法 (例如 $...$ 或 $$...$$ 或 \text{})。
    * 必須直接使用 Unicode 字元 (例如：β, α, °, ≈, mmHg)。`;

    // 您的 User Prompt (動態組合)
    let userPrompt = `--- 病患核心資料 (必填) START ---
${patientInfo}
--- 病患核心資料 END ---
`;

    if (specialtyFocus) {
        userPrompt += `\n--- 專科焦點 (選填) ---\n${specialtyFocus}\n`;
    }
    if (uptodateInfo) {
        userPrompt += `\n--- UpToDate 資料 (選填) START ---\n${uptodateInfo}\n--- UpToDate 資料 END ---\n`;
    }
    if (micromedexInfo) {
        userPrompt += `\n--- Micromedex 資料 (選填) START ---\n${micromedexInfo}\n--- Micromedex 資料 END ---\n`;
    }
    if (openevidenceInfo) {
        userPrompt += `\n--- OpenEvidence 資料 (選填) START ---\n${openevidenceInfo}\n--- OpenEvidence 資料 END ---\n`;
    }
    userPrompt += `\n請根據上述所有資訊，使用最新的國際指引產生一份藥師 SOAP 筆記。`;

    // --- 5. 呼叫 Gemini API ---
    try {
        const result = await model.generateContent({
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
        });

        // (v15.3 修正) 從 v1beta 更新
        // 'result.response.candidates[0].content.parts[0].text' 是舊版
        // 新版 SDK (v0.10.0+) 直接使用 .text()
        const response = result.response;
        const text = response.text();

        // (v15.3 修正) 取得 Google 搜尋的來源
        let sources = [];

        // 檢查 'groundingMetadata' (v1beta) 或 'citationMetadata'
        // @google/generative-ai SDK v0.10.0+ 使用 groundingMetadata
        const groundingMetadata = response.groundingMetadata;
        if (groundingMetadata && groundingMetadata.groundingAttributions) {
            sources = groundingMetadata.groundingAttributions
                .map(attr => ({
                    uri: attr.web?.uri,
                    title: attr.web?.title,
                }))
                .filter(source => source.uri && source.title);
        }

        // --- 6. 將結果回傳給 App ---
        // App 會收到一個 { soapNote: "...", sources: [...] } 的物件
        return {
            soapNote: text,
            sources: sources
        };

    } catch (error) {
        logger.error("Gemini API 呼叫失敗：", error);
        // 將錯誤訊息回傳給 App，方便除錯
        throw new HttpsError(
            "internal",
            `AI 引擎錯誤: ${error.message}`
        );
    }
});