import { capability } from "../kernel/index.js";
import type { TextModel } from "../../../modules/model/contracts/text-model.js";

export const TEXT_MODEL_CAPABILITY = capability<TextModel>(
  "model.text.generate",
);
