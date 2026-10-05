#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
printf 'int main(void) { return 0; }\n' > hello.c
cc hello.c -o hello-c
./hello-c
c++ hello.c -o hello-cpp
./hello-cpp
printf 'fn main() {}\n' > hello.rs
rustc hello.rs -o hello-rust
./hello-rust
printf 'package main\nfunc main() {}\n' > hello.go
go build -o hello-go hello.go
./hello-go
node -e 'if (1 + 1 !== 2) process.exit(1)'
python3 -c 'assert 1 + 1 == 2'
printf 'class Hello { public static void main(String[] args) {} }\n' > Hello.java
javac Hello.java
java Hello
mkdir dotnet-project empty-feed
cd dotnet-project
dotnet new console --no-restore >/dev/null
dotnet restore --source "$work/empty-feed" --ignore-failed-sources >/dev/null
dotnet run --no-restore >/dev/null
cd "$work"
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
