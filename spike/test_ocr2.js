// OCR retry — try alternate detector/recognizer combos + pipeline modes to dodge the 512-dim error.
import {
  loadModel, ocr, unloadModel,
  OCR_LATIN_RECOGNIZER, OCR_CRAFT_DETECTOR,
  OCR_DETECTOR_DB_MOBILENET_V3_LARGE, OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL,
  OCR_RECOGNIZER_PARSEQ, OCR_DETECTOR_DB_RESNET50,
} from "@qvac/sdk";
process.on("unhandledRejection", () => {});
process.on("uncaughtException", (e) => console.log(`uncaught: ${e?.message?.slice(0, 70)}`));

const IMG = "/Users/olathepavilion/Documents/qvac/spike/node_modules/@qvac/classification-ggml/test/images/report_1.jpg";

async function tryCfg(label, modelSrc, cfg) {
  let id;
  try {
    id = await loadModel({ modelSrc, modelType: "ocr", modelConfig: cfg });
    const { blocks } = ocr({ modelId: id, image: IMG });
    const out = await blocks;
    console.log(`\n[${label}] OK -> ${out.length} blocks`);
    out.slice(0, 8).forEach((b) => console.log(`   "${b.text}"  bbox=${JSON.stringify(b.bbox)}  conf=${b.confidence?.toFixed?.(2)}`));
  } catch (e) { console.log(`\n[${label}] FAIL: ${e.message?.split("\n")[0]}`); }
  try { if (id) await unloadModel(id); } catch {}
}

await tryCfg("A easyocr+batch1", OCR_LATIN_RECOGNIZER, { langList: ["en"], detectorModelSrc: OCR_CRAFT_DETECTOR, pipelineMode: "easyocr", recognizerBatchSize: 1 });
await tryCfg("B doctr-mobilenet", OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL, { langList: ["en"], detectorModelSrc: OCR_DETECTOR_DB_MOBILENET_V3_LARGE, pipelineMode: "doctr" });
await tryCfg("C doctr-parseq", OCR_RECOGNIZER_PARSEQ, { langList: ["en"], detectorModelSrc: OCR_DETECTOR_DB_RESNET50, pipelineMode: "doctr" });
console.log("\nOCR2 done.");
process.exit(0);
