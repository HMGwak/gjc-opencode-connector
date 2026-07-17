#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version_file="$repo_root/android/version.properties"
artifact_dir="$repo_root/artifacts"
release_date=${ANDROID_RELEASE_DATE:-$(date +%y%m%d)}

case "$release_date" in
  ??????) ;;
  *) echo "Android release date must use yymmdd: $release_date" >&2; exit 1 ;;
esac
case "$release_date" in
  *[!0-9]*) echo "Android release date must be numeric: $release_date" >&2; exit 1 ;;
esac

current_name=
while IFS='=' read -r key value; do
  [ "$key" = "VERSION_NAME" ] && current_name=$value
done < "$version_file"

release_number=1
case "$current_name" in
  "${release_date}_v"*)
    current_number=${current_name#"${release_date}_v"}
    case "$current_number" in
      ''|*[!0-9]*) ;;
      *) release_number=$((current_number + 1)) ;;
    esac
    ;;
esac
[ "$release_number" -le 99 ] || { echo "Android daily release limit reached for $release_date" >&2; exit 1; }

version_name="${release_date}_v${release_number}"
version_code="${release_date}$(printf '%02d' "$release_number")"
apk_name="planee-agent-hub-${version_name}.apk"
apk_path="$artifact_dir/$apk_name"

if [ -z "${JAVA_HOME:-}" ]; then
  if [ -d /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ]; then
    JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
  else
    JAVA_HOME=/Applications/Android\ Studio.app/Contents/jbr/Contents/Home
  fi
fi
ANDROID_HOME=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
export JAVA_HOME ANDROID_HOME

bun run --cwd "$repo_root" android:sync
(
  cd "$repo_root/android"
  ./gradlew --no-daemon assembleDebug --console=plain \
    -PplaneeVersionName="$version_name" \
    -PplaneeVersionCode="$version_code"
)

mkdir -p "$artifact_dir"
cp "$repo_root/android/app/build/outputs/apk/debug/app-debug.apk" "$apk_path"
(cd "$artifact_dir" && shasum -a 256 "$apk_name") > "$apk_path.sha256"

temporary_version_file="$version_file.tmp.$$"
trap 'rm -f "$temporary_version_file"' EXIT HUP INT TERM
printf 'VERSION_NAME=%s\nVERSION_CODE=%s\n' "$version_name" "$version_code" > "$temporary_version_file"
mv "$temporary_version_file" "$version_file"
trap - EXIT HUP INT TERM

printf 'Android release: %s\nAPK: %s\nSHA-256: %s.sha256\n' "$version_name" "$apk_path" "$apk_path"
