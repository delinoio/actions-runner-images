#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
probe() { printf '{"event":"smoke_probe","probe":"%s"}\n' "$1" >&2; }
probe c
printf 'int main(void) { return 0; }\n' > hello.c
cc hello.c -o hello-c
./hello-c
probe cpp
c++ hello.c -o hello-cpp
./hello-cpp
probe rust
printf 'fn main() {}\n' > hello.rs
rustc hello.rs -o hello-rust
./hello-rust
probe go
printf 'package main\nfunc main() {}\n' > hello.go
go build -o hello-go hello.go
./hello-go
probe node
node -e 'if (1 + 1 !== 2) process.exit(1)'
probe python
python3 -c 'assert 1 + 1 == 2'
probe java
printf 'class Hello { public static void main(String[] args) {} }\n' > Hello.java
javac Hello.java
java Hello
probe dotnet
mkdir dotnet-project empty-feed
cd dotnet-project
dotnet new console --no-restore >/dev/null
dotnet restore --source "$work/empty-feed" --ignore-failed-sources >/dev/null
dotnet run --no-restore >/dev/null
cd "$work"
probe android-sdk
sdk=/usr/local/lib/android/sdk
android_jar=$(find "$sdk/platforms" -name android.jar -type f | sort -V | tail -1)
build_tools=$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
test -f "$android_jar"
test -x "$build_tools/aapt2"
test -x "$build_tools/d8"
mkdir -p res/values dex
printf '<resources><string name="app_name">CI smoke</string></resources>\n' > res/values/strings.xml
printf '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="io.delino.ci.smoke"><uses-sdk android:minSdkVersion="29" android:targetSdkVersion="29"/><application android:label="@string/app_name"/></manifest>\n' > AndroidManifest.xml
"$build_tools/aapt2" compile --dir res -o resources.zip
"$build_tools/aapt2" link -o application.apk --manifest AndroidManifest.xml -I "$android_jar" resources.zip
printf 'class HelloAndroid extends android.app.Activity {}\n' > HelloAndroid.java
javac --release 8 -cp "$android_jar" HelloAndroid.java
"$build_tools/d8" --lib "$android_jar" --min-api 29 --output dex HelloAndroid.class
test -s application.apk
test -s dex/classes.dex
probe android-ndk
# Compile with every installed NDK without downloading packages or requiring an emulator.
for ndk in /usr/local/lib/android/sdk/ndk/*; do
  test -d "$ndk"
  "$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android29-clang" -c hello.c -o android.o
  "$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android29-clang++" -c hello.c -o android-cpp.o
  test -s android.o
  test -s android-cpp.o
done
test "$(id -u)" = 1001
test "$(id -g)" = 1001
command -v docker >/dev/null
test -d /opt/hostedtoolcache
test -d /opt/runmoor-runner
test -w /opt/runmoor-runner
