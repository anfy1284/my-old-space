@echo off
call C:\Users\anfy1\emsdk\emsdk_env.bat

if not exist resources\public mkdir resources\public

echo Compiling CppApp...
call emcc main.cpp -o resources\public\CppApp.js -s MODULARIZE=1 -s EXPORT_NAME='createCppApp' -s ENVIRONMENT='web' -s DYNAMIC_EXECUTION=0

echo Compiling TestApp...
call emcc test.cpp -o resources\public\TestApp.js -s MODULARIZE=1 -s EXPORT_NAME='createTestApp' -s ENVIRONMENT='web' -s DYNAMIC_EXECUTION=0

if errorlevel 1 (
    echo Compilation failed.
    pause
    exit /b 1
)

echo Build complete.
pause
