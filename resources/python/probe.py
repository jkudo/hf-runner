"""Python エンジンの状態 (torch / transformers / GPU) を 1 行の JSON で出力する"""
import json
import sys

out = {"python": sys.version.split()[0]}
try:
    import torch

    out["torch"] = torch.__version__
    out["cuda"] = bool(torch.cuda.is_available())
    devices = []
    if out["cuda"]:
        for i in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(i)
            try:
                free, total = torch.cuda.mem_get_info(i)
            except Exception:
                free, total = 0, props.total_memory
            devices.append(
                {
                    "id": f"CUDA{i}",
                    "name": torch.cuda.get_device_name(i),
                    "totalMiB": int(total // (1024 * 1024)),
                    "freeMiB": int(free // (1024 * 1024)),
                }
            )
    out["devices"] = devices
except Exception as e:  # noqa: BLE001
    out["error"] = f"{type(e).__name__}: {e}"
try:
    import transformers

    out["transformers"] = transformers.__version__
except Exception as e:  # noqa: BLE001
    out["error"] = f"{type(e).__name__}: {e}"
try:
    import bitsandbytes  # noqa: F401

    out["bitsandbytes"] = True
except Exception:  # noqa: BLE001
    out["bitsandbytes"] = False
print(json.dumps(out))
