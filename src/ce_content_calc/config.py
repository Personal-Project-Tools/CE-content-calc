"""Centralized paths, content labels, and column resolution rules."""

from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = PROJECT_ROOT / "config"
DATA_DIR = PROJECT_ROOT / "data"

DEFAULT_RAW_FILE_DIR = DATA_DIR / "raw_file"
DEFAULT_REPORTS_DIR = DEFAULT_RAW_FILE_DIR
DEFAULT_RESULTS_DIR = DATA_DIR / "reports"
DEFAULT_OUTPUT_FILE = DEFAULT_RESULTS_DIR / "tiktok_content_metrics.xlsx"
DEFAULT_SHEET_CONFIG_FILE = CONFIG_DIR / "sheet.yaml"
DEFAULT_SERVICE_ACCOUNT_FILE = CONFIG_DIR / "service.json"

CONTENT_TYPES = {
    "live": "TikTok Content Live",
    "video": "TikTok Content Video",
}

METRIC_RULES = {
    "live": {
        "revenue": {
            "headers": ("LIVE-attributed GMV",),
            "fallback_index": 5,  # 1-based col 6 -> 0-based index 5
        },
        "product_impression": {
            "headers": ("Product Impressions",),
            "fallback_index": 25,  # 1-based col 26 -> 0-based index 25
        },
        "impression": {
            "headers": ("Views",),
            "fallback_index": 19,  # 1-based col 20 -> 0-based index 19
        },
    },
    "video": {
        "revenue": {
            "headers": ("Video-attributed GMV",),
            "fallback_index": 22,  # 0-based index 22
        },
        "product_impression": {
            "headers": ("Product Impressions",),
            "fallback_index": 13,  # 0-based index 13
        },
        "impression": {
            "headers": ("Video Views", "Video views", "VV"),
            "fallback_index": 7,  # 0-based index 7
        },
    },
}
