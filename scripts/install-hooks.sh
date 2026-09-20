#!/bin/bash

# 为项目安装 Git hooks。
# 本脚本创建一个 pre-commit hook，用于运行 make pre-commit。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HOOKS_DIR="$PROJECT_ROOT/.git/hooks"

# 检查是否位于 git 仓库中。
if [[ ! -d "$PROJECT_ROOT/.git" ]]; then
    echo "❌ 错误：当前不在 git 仓库中"
    exit 1
fi

# 不存在时创建 hooks 目录。
mkdir -p "$HOOKS_DIR"

# 创建 pre-commit hook。
PRE_COMMIT_HOOK="$HOOKS_DIR/pre-commit"

cat > "$PRE_COMMIT_HOOK" << 'EOF'
#!/bin/bash

# Git pre-commit 钩子
# 运行 make pre-commit 以保证代码质量，并处理自动格式化。

set -e

echo "🔍 正在运行 pre-commit 检查..."

# 切换到项目根目录。
cd "$(git rev-parse --show-toplevel)"

# 检查是否存在已暂存的文件。
if git diff --cached --quiet; then
    echo "ℹ️  没有已暂存的改动"
    exit 0
fi

# 在运行 pre-commit 前记录已暂存文件列表。
STAGED_FILES=$(git diff --cached --name-only)

# 运行 pre-commit 检查。
if ! make pre-commit; then
    echo "❌ pre-commit 检查失败！"
    echo "请先修复上面的问题，然后重新提交。"
    echo "如需跳过 pre-commit 检查，请使用 'git commit --no-verify'"
    exit 1
fi

# 检查是否有已暂存文件被 pre-commit 修改。
MODIFIED_FILES=""
for file in $STAGED_FILES; do
    if [[ -f "$file" ]] && ! git diff --quiet HEAD -- "$file" 2>/dev/null; then
        # 检查文件是否有未暂存的改动（即被 pre-commit 修改过）。
        if ! git diff --quiet -- "$file" 2>/dev/null; then
            MODIFIED_FILES="$MODIFIED_FILES $file"
        fi
    fi
done

# 文件被自动格式化后，重新加入暂存区。
if [[ -n "$MODIFIED_FILES" ]]; then
    echo "🔧 检测到自动格式化，正在将被修改的文件加入暂存区："
    for file in $MODIFIED_FILES; do
        echo "   - $file"
        git add "$file"
    done
    echo "✅ 已将被修改的文件暂存以提交"
fi

echo "✅ pre-commit 检查通过！"
exit 0
EOF

# 给 hook 加上可执行权限。
chmod +x "$PRE_COMMIT_HOOK"

echo "✅ Git pre-commit 钩子安装成功！"
echo "   该钩子会在每次提交前运行 'make pre-commit'。"
echo ""
echo "如需临时禁用该钩子，请使用："
echo "   git commit --no-verify"
echo ""
echo "如需卸载该钩子，请删除："
echo "   $PRE_COMMIT_HOOK"