# Windows Binaries

This folder contains bundled executables for Windows printing support.

## SumatraPDF.exe

Required for reliable PDF label printing on Windows.

### Download Instructions

1. Download the portable 64-bit version from: https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.zip
2. Extract `SumatraPDF.exe` from the zip
3. Place it in this folder (`desktop/binaries/win/SumatraPDF.exe`)

### License

SumatraPDF is free and open source (GPL-3 license).
https://github.com/ArtifexSoftware/sumatrapdf

### Usage

The desktop app automatically bundles this executable and uses it for printing labels with the command:
```
SumatraPDF.exe -print-to "[printer name]" -silent "[pdf file path]"
```
