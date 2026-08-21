# Oxidize
A simple in-browser editor based on Monaco and xterm, with boosted C++, that I use for lightweight dev
## Build

```sh
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

```sh
./build/main/oxidize ~/workspace --host 0.0.0.0 --port 12000
```
