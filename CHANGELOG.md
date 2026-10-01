# Changelog

All notable changes to HF Runner are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-01

### Added

- "Thinking" option in the chat's Parameters (Standard / Short / Minimal / Off) for models that think before answering (Qwen3, DeepSeek-R1, gpt-oss, …). Short and Minimal cap the thinking at 1,024 / 256 tokens and then make the model answer; Off answers without thinking. Works with llama.cpp and the Python engine, and takes effect from the next message
- "Max output tokens" in the chat's Parameters has a slider that snaps to common values (128 – 32,768) next to a box for any other value. A note appears when the value is larger than the context length

### Fixed

- Text typed with an IME (Japanese, Chinese, Korean, …) in the chat's system prompt was duplicated while converting ("ああいあいう…")
- When thinking used up the max output tokens or the context length, the chat ended with an empty answer and no explanation. It now says which limit was reached and what to change
- Python engine: with a very large max output tokens (e.g. 999999), the input was cut down to 64 tokens, dropping the system prompt and earlier messages. Output now stops at the end of the context instead

## [0.1.0] - 2026-09-30

First public release. A Windows desktop app to find models on Hugging Face, download them and run them on your own PC.

### Models and engines

- Search Hugging Face and see, for every file in a repository (Q4_K_M, Q8_0, …), whether it fits this PC's RAM / VRAM before downloading. Only the start of each file is read to decide
- Three inference engines, downloaded from their official releases when needed:
  - [llama.cpp](https://github.com/ggml-org/llama.cpp) for GGUF (Vulkan / CUDA 12 / CUDA 13 / CPU)
  - Python + [Transformers](https://github.com/huggingface/transformers) for safetensors, in a dedicated environment managed by uv (CUDA / CPU, 8-bit / 4-bit loading)
  - [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) for image generation (Vulkan / CUDA 12 / ROCm / CPU)
- Files that cannot run as they are (speculative-decoding drafts, custom quantizations such as `PTQ1_0`, formats the engines can't read) are flagged with the reason, and downloading / launching is blocked
- Fast, resumable downloads over several parallel connections

### Chat and image generation

- Chat with text-generation models; reasoning (`<think>`) is shown folded
- Vision-language models: attach images by pasting, dropping or the attach button
- Image generation with Stable Diffusion 1.x / 2.x / SDXL, FLUX.1, SD3.5 and Qwen-Image / Qwen-Image 2.1. Required components (VAE, text encoders) are downloaded automatically and shared between models; components with commercial-use restrictions are marked
- Prompts in other languages can be translated into English automatically with a local model (Qwen3-4B-Instruct-2507 or Qwen3-1.7B)

### Use from other apps

- The loaded model is available as an OpenAI-compatible API on `127.0.0.1` (the next free port is used if the default one is taken)
- Server mode: let other PCs, phones and apps on the same network use the loaded model, protected by an API key. Optionally keep running in the system tray

### Settings

- GPU to use: automatic (prefers a discrete GPU over the integrated one) or a specific GPU, applied to all three engines
- Each engine's launch command can be edited, with placeholders such as `{model}` and `{port}`
- English and Japanese UI (follows the OS language by default)

### Distribution

- Installer (`.exe`) and a no-install zip version that keeps the app, engines and models in one folder
- The app is not code-signed: Windows SmartScreen shows a warning on first run ("More info" → "Run anyway")

[Unreleased]: ../../compare/v0.1.1...HEAD
[0.1.1]: ../../compare/v0.1.0...v0.1.1
[0.1.0]: ../../releases/tag/v0.1.0
