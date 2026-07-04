python -m venv tts-env
source tts-env/bin/activate
pip install fastapi uvicorn kokoro-onnx soundfile pydantic -v
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
chmod +x run.sh
./run.sh

put them in the same folder
