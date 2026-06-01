const { GoogleGenerativeAI } = require('@google/generative-ai');

const DEFAULT_MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001'
];

const SYSTEM_PROMPT = `You are FeedbackFlow AI, an expert software development assistant that analyzes client feedback and converts it into structured, actionable development tasks.

Your task is to analyze the provided feedback and return a JSON response with the following structure:

{
  "summary": "Brief 1-2 sentence summary of the overall feedback",
  "tasks": [
    {
      "title": "Short, action-oriented task title (max 80 chars)",
      "description": "Detailed description of what needs to be done and why",
      "priority": "High|Medium|Low",
      "category": "UI|UX|Bug|Performance|Feature|Other",
      "suggestion": "Specific implementation suggestion or recommendation",
      "estimatedMinutes": 30,
      "tailwindFix": "Optional Tailwind CSS code snippet if applicable (null if not)"
    }
  ],
  "overallInsights": "Key patterns observed in the feedback",
  "quickWins": ["List of quick wins that can be implemented immediately"]
}

Priority Guidelines:
- High: Broken functionality, critical UX failures, accessibility issues, conversion blockers
- Medium: Significant UX improvements, visual inconsistencies, performance issues
- Low: Nice-to-have improvements, minor visual tweaks, future enhancements

Category Guidelines:
- UI: Visual design, colors, typography, spacing, layout, icons
- UX: User flows, interactions, usability, navigation, information architecture
- Bug: Broken functionality, errors, crashes, unexpected behavior
- Performance: Loading speed, optimization, caching, resource usage
- Feature: New functionality requests
- Other: Everything else

Estimated Time Guidelines:
- Return estimatedMinutes as an integer number of minutes.
- Small visual fixes are usually 10-20 minutes.
- Validation, UX, or component fixes are usually 20-60 minutes.
- Larger widgets or workflow features are usually 90-240 minutes.

Always return valid JSON only. No markdown, no extra text. Be specific and actionable.`;

class GeminiService {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY;
    if (!this.apiKey) {
      throw new Error('Gemini API key is required');
    }
    this.genAI = new GoogleGenerativeAI(this.apiKey);
    const configuredModel = process.env.GEMINI_MODEL?.trim();
    this.modelCandidates = configuredModel
      ? [configuredModel, ...DEFAULT_MODEL_CANDIDATES.filter(m => m !== configuredModel)]
      : DEFAULT_MODEL_CANDIDATES;
  }

  isModelNotFoundError(err) {
    const msg = String(err?.message || '').toLowerCase();
    return msg.includes('404') || msg.includes('not found for api version') || msg.includes('is not found');
  }

  async generateWithFallback(content) {
    let lastError;

    for (const modelName of this.modelCandidates) {
      try {
        const model = this.genAI.getGenerativeModel({ model: modelName });
        return await model.generateContent(content);
      } catch (err) {
        lastError = err;
        if (this.isModelNotFoundError(err)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      `No supported Gemini model found. Tried: ${this.modelCandidates.join(', ')}. ` +
      `Set GEMINI_MODEL in backend/.env to a model available for your API key.`
    );
  }

  parseAndValidateResponse(text) {
    const cleaned = text
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/gi, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('Invalid AI response structure');
    }

    parsed.tasks = parsed.tasks.map((task, index) => ({
      title: task.title?.substring(0, 200) || `Task ${index + 1}`,
      description: task.description?.substring(0, 2000) || '',
      priority: ['High', 'Medium', 'Low'].includes(task.priority) ? task.priority : 'Medium',
      category: ['UI', 'UX', 'Bug', 'Performance', 'Feature', 'Other'].includes(task.category) ? task.category : 'Other',
      suggestion: task.suggestion?.substring(0, 2000) || null,
      estimatedMinutes: Number.isFinite(Number(task.estimatedMinutes))
        ? Math.min(10080, Math.max(1, Math.round(Number(task.estimatedMinutes))))
        : 30,
      tailwindFix: task.tailwindFix || null
    }));

    return parsed;
  }

  async analyzeFeedback(feedbackContent, feedbackType = 'text') {
    const prompt = `${SYSTEM_PROMPT}

Feedback Type: ${feedbackType}
Feedback Content:
---
${feedbackContent}
---

Analyze this feedback and return the structured JSON response:`;

    try {
      const result = await this.generateWithFallback(prompt);
      const response = await result.response;
      const text = response.text();
      return this.parseAndValidateResponse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error('AI returned invalid JSON response. Please try again.');
      }
      throw err;
    }
  }

  async analyzeImageFeedback(imageBuffer, mimeType = 'image/png', fileName = 'upload') {
    const imagePrompt = `${SYSTEM_PROMPT}

Feedback Type: image_upload
You are analyzing a screenshot/design image uploaded by a user (${fileName}).
Extract visible UI/UX issues, bugs, readability problems, hierarchy issues, and actionable improvements.
If text is visible in the image, use it as context.

Return the structured JSON response only.`;

    try {
      const result = await this.generateWithFallback([
        { text: imagePrompt },
        {
          inlineData: {
            mimeType,
            data: imageBuffer.toString('base64')
          }
        }
      ]);

      const response = await result.response;
      const text = response.text();
      return this.parseAndValidateResponse(text);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error('AI returned invalid JSON response. Please try again.');
      }
      throw err;
    }
  }

  async analyzeLoomTranscript(loomUrl) {
    // Since Loom API requires authentication, we simulate transcript extraction
    // In production, you'd integrate with Loom's API or a transcript service
    const simulatedPrompt = `The user provided a Loom video URL: ${loomUrl}
    
Since direct Loom transcript access requires Loom API integration, please generate a helpful analysis acknowledging this is a Loom video feedback session.
Create 3-5 generic but realistic UI/UX improvement tasks that would commonly come from a design review session.
Mention in the task descriptions that these are suggested tasks pending actual transcript review.`;

    return await this.analyzeFeedback(simulatedPrompt, 'loom_video');
  }
}

// Factory function to create service with user's API key or system key
const createGeminiService = (userApiKey) => {
  const apiKey = userApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('No Gemini API key configured. Please add your API key in Settings.');
  }
  return new GeminiService(apiKey);
};

module.exports = { GeminiService, createGeminiService };
