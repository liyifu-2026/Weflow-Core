import type { TextGenerationRequest } from "./text-generation-request.js";
import type { TextGenerationResult } from "./text-generation-result.js";

export interface TextModel {
  generate(request: TextGenerationRequest): Promise<TextGenerationResult>;
}
