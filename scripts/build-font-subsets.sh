#!/usr/bin/env bash
# 生成界面中文字体的 woff2 子集（产物提交进仓库，不要手工编辑）。
#
# 源字体需自行下载，两者均为 SIL OFL 1.1：
#   思源宋体 CN Regular  https://github.com/adobe-fonts/source-han-serif（release 分支 SubsetOTF/CN/）
#   寒蝉正楷体            https://github.com/Warren2060/Chillkai（releases → ChillKai.zip）
# 两者都声明了 Reserved Font Name（思源宋体为 'Source'），派生的子集因此改用 AeroLink 自有名称，
# 版权、OFL 声明与商标记录原样保留。
#
# 子集范围 = GB2312 全集 + ui/src/i18n/locales/zh.json 中出现的字符 + ASCII。
#
# 用法：scripts/build-font-subsets.sh <思源宋体-OTF> <寒蝉正楷体-TTF>
#       某个源文件暂不可得时传 `-` 跳过该字体。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/ui/src/assets/fonts"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

SONG_SRC="${1:-}"
KAI_SRC="${2:-}"
if [[ -z "$SONG_SRC" || -z "$KAI_SRC" ]]; then
  echo "用法：$0 <思源宋体CN-Regular.otf> <寒蝉正楷体.ttf>（任一传 - 表示跳过）" >&2
  exit 1
fi

REPO_ROOT="$REPO_ROOT" CHARSET_OUT="$WORK_DIR/charset.txt" python3 - <<'PY'
import json
import os
import pathlib

chars = set()
# GB2312 全集（6763 汉字 + 682 符号）
for high in range(0xA1, 0xF8):
    for low in range(0xA1, 0xFF):
        try:
            chars.add(bytes([high, low]).decode('gb2312'))
        except UnicodeDecodeError:
            pass
# 界面文案里出现的字符（补全 GB2312 之外的生僻字）
locales = pathlib.Path(os.environ['REPO_ROOT'], 'ui/src/i18n/locales/zh.json')
zh = json.loads(locales.read_text('utf-8'))


def walk(node):
    if isinstance(node, dict):
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
    elif isinstance(node, str):
        chars.update(node)


walk(zh)
chars.update(chr(code) for code in range(0x20, 0x7F))
chars = sorted(c for c in chars if c.strip())
pathlib.Path(os.environ['CHARSET_OUT']).write_text(''.join(chars), 'utf-8')
print(f'子集字符数：{len(chars)}')
PY

# $1 源字体 $2 产物文件名 $3 家族名 $4 PostScript 名
build_subset() {
  local source="$1"
  local output="$2"
  local family="$3"
  local postscript="$4"

  pyftsubset "$source" \
    --text-file="$WORK_DIR/charset.txt" \
    --flavor=woff2 \
    --drop-tables+=vhea,vmtx \
    --name-IDs+=13,14 \
    --output-file="$WORK_DIR/$output"

  python3 - "$WORK_DIR/$output" "$family" "$postscript" <<'PY'
import sys

from fontTools.ttLib import TTFont

path, family, postscript = sys.argv[1], sys.argv[2], sys.argv[3]
font = TTFont(path)
name = font['name']

# 版权（0）、许可描述与链接（13/14）、商标（7）保持来源原始文本，只在版权里注明本仓库的修改。
copyright_notice = name.getDebugName(0) or ''
suffix = ' Subset and renamed by the AeroLink project in 2026; no Reserved Font Name is used.'
name.removeNames(nameID=0)
name.setName(copyright_notice + suffix, 0, 3, 1, 0x409)

renames = {
    1: family,
    2: 'Regular',
    3: f'{postscript};2.0;{postscript}',
    4: family,
    6: postscript,
    16: family,
    17: 'Regular',
}
name.removeNames(nameID=list(renames))
for name_id, value in renames.items():
    name.setName(value, name_id, 3, 1, 0x409)
    name.setName(value, name_id, 1, 0, 0)

font.save(path)
print(f'{path} → {family} / {postscript}')
PY

  cp "$WORK_DIR/$output" "$OUT_DIR/$output"
  ls -l "$OUT_DIR/$output"
}

mkdir -p "$OUT_DIR"
[[ "$SONG_SRC" == '-' ]] || build_subset "$SONG_SRC" 'aerolink-song-sc-400-normal.woff2' 'AeroLink Song SC' 'AeroLinkSongSC-Regular'
[[ "$KAI_SRC" == '-' ]] || build_subset "$KAI_SRC" 'aerolink-kai-400-normal.woff2' 'AeroLink Kai' 'AeroLinkKai-Regular'
