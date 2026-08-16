//! Catalogue of on-device speech models.
//!
//! Ported from Orca (https://github.com/stablyai/orca), MIT licensed. The pinned
//! revisions and per-file hashes come from there: an immutable revision plus a
//! hash makes a direct download equivalent to a pinned archive, so a model cannot
//! change under the app between installs.

/// How the model is wired into sherpa. Each shape needs a different config, and
/// streaming needs a different recognizer altogether.
#[derive(PartialEq, Eq, Clone, Copy)]
pub enum ModelKind {
    /// encoder + decoder + joiner, decoded offline.
    Transducer,
    /// Single `model.onnx`, CTC head.
    Ctc,
    Whisper,
    SenseVoice,
    /// encoder + decoder, no joiner.
    Paraformer,
    /// Transducer decoded as audio arrives. Needs OnlineRecognizer, not wired yet.
    StreamingTransducer,
}

impl ModelKind {
    /// Whether dictation can currently load this shape.
    pub fn supported(self) -> bool {
        !matches!(self, ModelKind::StreamingTransducer)
    }
}

/// One file of a model, with the size and digest expected after download.
pub struct ModelFile {
    pub name: &'static str,
    pub url: &'static str,
    pub size_bytes: u64,
    pub sha256: &'static str,
}

pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub language: &'static str,
    /// Streaming models transcribe as you speak; offline ones need the full clip.
    pub streaming: bool,
    pub recommended: bool,
    pub kind: ModelKind,
    pub files: &'static [ModelFile],
}

impl ModelSpec {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size_bytes).sum()
    }
}

pub fn catalog() -> &'static [ModelSpec] {
    CATALOG
}

pub fn find(id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|spec| spec.id == id)
}

static CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "parakeet-tdt-0.6b-v3-int8",
        kind: ModelKind::Transducer,
        label: "Parakeet TDT v3",
        description: "Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.",
        language: "multilingual",
        streaming: false,
        recommended: true,
        files: &[
        ModelFile {
            name: "encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/encoder.int8.onnx?download=true",
            size_bytes: 652184281,
            sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
        },
        ModelFile {
            name: "decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/decoder.int8.onnx?download=true",
            size_bytes: 11845275,
            sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
        },
        ModelFile {
            name: "joiner.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/joiner.int8.onnx?download=true",
            size_bytes: 6355277,
            sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/tokens.txt?download=true",
            size_bytes: 93939,
            sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
        },
        ],
    },
    ModelSpec {
        id: "parakeet-tdt-0.6b-v2-int8",
        kind: ModelKind::Transducer,
        label: "Parakeet TDT v2",
        description: "English only. Faster than v3 with similar accuracy. Punctuation and capitalization.",
        language: "en",
        streaming: false,
        recommended: false,
        files: &[
        ModelFile {
            name: "encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/1ab9323565ddb038682214b292f588070a538ce2/encoder.int8.onnx?download=true",
            size_bytes: 652184296,
            sha256: "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab",
        },
        ModelFile {
            name: "decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/1ab9323565ddb038682214b292f588070a538ce2/decoder.int8.onnx?download=true",
            size_bytes: 7257753,
            sha256: "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e",
        },
        ModelFile {
            name: "joiner.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/1ab9323565ddb038682214b292f588070a538ce2/joiner.int8.onnx?download=true",
            size_bytes: 1739080,
            sha256: "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/1ab9323565ddb038682214b292f588070a538ce2/tokens.txt?download=true",
            size_bytes: 9384,
            sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
        },
        ],
    },
    ModelSpec {
        id: "sense-voice-zh-en-ja-ko-yue",
        kind: ModelKind::SenseVoice,
        label: "SenseVoice",
        description: "Chinese, English, Japanese, Korean, and Cantonese with automatic language detection.",
        language: "multilingual",
        streaming: false,
        recommended: false,
        files: &[
        ModelFile {
            name: "model.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx?download=true",
            size_bytes: 239233841,
            sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt?download=true",
            size_bytes: 315894,
            sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
        },
        ],
    },
    ModelSpec {
        id: "whisper-tiny",
        kind: ModelKind::Whisper,
        label: "Whisper Tiny",
        description: "90+ languages. Lower accuracy than Parakeet but broadest language coverage.",
        language: "multilingual",
        streaming: false,
        recommended: false,
        files: &[
        ModelFile {
            name: "tiny-encoder.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/65176e2deb88badc814a94058666cadccc29b61c/tiny-encoder.onnx?download=true",
            size_bytes: 37647080,
            sha256: "42c1d4cbf889632ba21ab6f0d4064c80209755f265ce5cd630db4a6793e7089c",
        },
        ModelFile {
            name: "tiny-decoder.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/65176e2deb88badc814a94058666cadccc29b61c/tiny-decoder.onnx?download=true",
            size_bytes: 114505801,
            sha256: "e144c07dc6b55cece24392811f2d934b97013811f5e677d1315d341a0a74a25d",
        },
        ModelFile {
            name: "tiny-tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/65176e2deb88badc814a94058666cadccc29b61c/tiny-tokens.txt?download=true",
            size_bytes: 816730,
            sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        },
        ],
    },
    ModelSpec {
        id: "zipformer-bilingual-zh-en",
        kind: ModelKind::StreamingTransducer,
        label: "Zipformer Bilingual",
        description: "Chinese + English with code-switching. Low-latency real-time streaming.",
        language: "zh-en",
        streaming: true,
        recommended: false,
        files: &[
        ModelFile {
            name: "encoder-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/98590b7ed6443e77b714204da2757d75e1a642f4/encoder-epoch-99-avg-1.onnx?download=true",
            size_bytes: 330083505,
            sha256: "709f0ed53a734b7942f170127e7547b566cb29c4afc5e67719f314c3d63ccb10",
        },
        ModelFile {
            name: "decoder-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/98590b7ed6443e77b714204da2757d75e1a642f4/decoder-epoch-99-avg-1.onnx?download=true",
            size_bytes: 13876452,
            sha256: "2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d",
        },
        ModelFile {
            name: "joiner-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/98590b7ed6443e77b714204da2757d75e1a642f4/joiner-epoch-99-avg-1.onnx?download=true",
            size_bytes: 12833618,
            sha256: "5f2adc585dd1bec6421c8bb8660d2a73fc8b9ceb24491ef51399ba2a2f0fc31b",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/98590b7ed6443e77b714204da2757d75e1a642f4/tokens.txt?download=true",
            size_bytes: 56317,
            sha256: "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3",
        },
        ModelFile {
            name: "bpe.vocab",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/98590b7ed6443e77b714204da2757d75e1a642f4/bpe.vocab?download=true",
            size_bytes: 12564,
            sha256: "d0b642f3a2eacd5fadefdeff9e0e1358cab729647cbb7fe58cf738e1f7407029",
        },
        ],
    },
    ModelSpec {
        id: "paraformer-bilingual-zh-en",
        kind: ModelKind::Paraformer,
        label: "Paraformer Bilingual",
        description: "Chinese (Mandarin + dialects) + English. Strong on accented and regional Chinese.",
        language: "zh-en",
        streaming: true,
        recommended: false,
        files: &[
        ModelFile {
            name: "encoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/8e40c43232a1c5c66c82111efc5820d3accca11b/encoder.int8.onnx?download=true",
            size_bytes: 165462184,
            sha256: "81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a",
        },
        ModelFile {
            name: "decoder.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/8e40c43232a1c5c66c82111efc5820d3accca11b/decoder.int8.onnx?download=true",
            size_bytes: 71664561,
            sha256: "f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/8e40c43232a1c5c66c82111efc5820d3accca11b/tokens.txt?download=true",
            size_bytes: 75756,
            sha256: "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6",
        },
        ],
    },
    ModelSpec {
        id: "zipformer-streaming-en-20m",
        kind: ModelKind::StreamingTransducer,
        label: "Zipformer Streaming EN",
        description: "English only. Lightweight 20M-param model, good balance of speed and size.",
        language: "en",
        streaming: true,
        recommended: false,
        files: &[
        ModelFile {
            name: "encoder-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/d42f2d9f7ca24806fb667456a18a9f1b60f70d16/encoder-epoch-99-avg-1.onnx?download=true",
            size_bytes: 88804590,
            sha256: "f77a22f4ff94604e1afb2aeb13504d7699363528c047c97d3436087c95c9b659",
        },
        ModelFile {
            name: "decoder-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/d42f2d9f7ca24806fb667456a18a9f1b60f70d16/decoder-epoch-99-avg-1.onnx?download=true",
            size_bytes: 2092272,
            sha256: "45a7f940ecfb53d89fa270ad11b88b961e53a317203eb24b1c8e95ed208b0f30",
        },
        ModelFile {
            name: "joiner-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/d42f2d9f7ca24806fb667456a18a9f1b60f70d16/joiner-epoch-99-avg-1.onnx?download=true",
            size_bytes: 1026462,
            sha256: "343e17dffa4f386ca206e00d3c406908f68f473c3d35968d6c3cddd5b8559a94",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17/resolve/d42f2d9f7ca24806fb667456a18a9f1b60f70d16/tokens.txt?download=true",
            size_bytes: 5048,
            sha256: "49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb",
        },
        ],
    },
    ModelSpec {
        id: "zipformer-streaming-zh-14m",
        kind: ModelKind::StreamingTransducer,
        label: "Zipformer Streaming ZH",
        description: "Chinese only. Ultra-lightweight 14M-param model, ideal for low-resource devices.",
        language: "zh",
        streaming: true,
        recommended: false,
        files: &[
        ModelFile {
            name: "encoder-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/204ad334e2e683fd295359930cc16fc0432a23ac/encoder-epoch-99-avg-1.onnx?download=true",
            size_bytes: 40948171,
            sha256: "84c6a8f372686faa5b8f45f2d79f0816f76dcd9f547acb9a90eba2772d7eda8b",
        },
        ModelFile {
            name: "decoder-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/204ad334e2e683fd295359930cc16fc0432a23ac/decoder-epoch-99-avg-1.onnx?download=true",
            size_bytes: 7509745,
            sha256: "5ee0f03a2768ff1d5c83ef3a493243c7935d316cd41280037b14783a3467cc78",
        },
        ModelFile {
            name: "joiner-epoch-99-avg-1.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/204ad334e2e683fd295359930cc16fc0432a23ac/joiner-epoch-99-avg-1.onnx?download=true",
            size_bytes: 7109975,
            sha256: "030212efaea9a8b6a4fa98faf6ac6055529c4408cf4865e898220ddd02780f34",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/204ad334e2e683fd295359930cc16fc0432a23ac/tokens.txt?download=true",
            size_bytes: 48697,
            sha256: "8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac",
        },
        ],
    },
    ModelSpec {
        id: "zipformer-streaming-korean",
        kind: ModelKind::StreamingTransducer,
        label: "Zipformer Streaming KO",
        description: "Korean only. Low-latency real-time streaming.",
        language: "ko",
        streaming: true,
        recommended: false,
        files: &[
        ModelFile {
            name: "encoder-epoch-99-avg-1.int8.onnx",
            url: "https://huggingface.co/k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16/resolve/ba6078bca4daf3f0dd37f79d0ab505af71df14a6/encoder-epoch-99-avg-1.int8.onnx?download=true",
            size_bytes: 126968852,
            sha256: "8d0b1aa24fbedd4e3948564ab7facd151b8ce9b0c48fc987c541de2de3af5697",
        },
        ModelFile {
            name: "decoder-epoch-99-avg-1.int8.onnx",
            url: "https://huggingface.co/k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16/resolve/ba6078bca4daf3f0dd37f79d0ab505af71df14a6/decoder-epoch-99-avg-1.int8.onnx?download=true",
            size_bytes: 2844692,
            sha256: "68ea197936aabd249f38b53a87c775422bca64428ad4427d0e6e8092593e71fb",
        },
        ModelFile {
            name: "joiner-epoch-99-avg-1.int8.onnx",
            url: "https://huggingface.co/k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16/resolve/ba6078bca4daf3f0dd37f79d0ab505af71df14a6/joiner-epoch-99-avg-1.int8.onnx?download=true",
            size_bytes: 2581421,
            sha256: "128b80a66a1f718488af8560f9d15895109b99ff3e573f0a0130e03774ef1ced",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/k2-fsa/sherpa-onnx-streaming-zipformer-korean-2024-06-16/resolve/ba6078bca4daf3f0dd37f79d0ab505af71df14a6/tokens.txt?download=true",
            size_bytes: 60246,
            sha256: "016bdf0965029263b7ad01b742366ee542ef0bef38261510e8176ff6f2e9e668",
        },
        ],
    },
    ModelSpec {
        id: "parakeet-tdt-ctc-0.6b-ja-int8",
        kind: ModelKind::Ctc,
        label: "Parakeet TDT-CTC JA",
        description: "Japanese only. Trained on 35k+ hours of natural speech. Punctuation included.",
        language: "ja",
        streaming: false,
        recommended: false,
        files: &[
        ModelFile {
            name: "model.int8.onnx",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/model.int8.onnx?download=true",
            size_bytes: 655542604,
            sha256: "3addd00ef5bd1742078389e540b77394e4a508bdf2f4c9ad1b4a76d93e76598e",
        },
        ModelFile {
            name: "tokens.txt",
            url: "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8/resolve/bef18eb066808c90bd0f5df5be685767b0732de8/tokens.txt?download=true",
            size_bytes: 28557,
            sha256: "732f64c53909f2620c713f4106b487d92e6f54a6915b3cd3d1dbd32f9f4f392a",
        },
        ],
    },
];
