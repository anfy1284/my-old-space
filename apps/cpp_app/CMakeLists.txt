cmake_minimum_required(VERSION 3.10)

project(CppApp)

set(CMAKE_CXX_STANDARD 17)

# Check if we are building with Emscripten
if(EMSCRIPTEN)
    set(CMAKE_EXECUTABLE_SUFFIX ".html")
    set(COMMON_FLAGS "-s MODULARIZE=1 -s ENVIRONMENT='web'")
endif()

add_executable(CppApp main.cpp)
if(EMSCRIPTEN)
    set_target_properties(CppApp PROPERTIES LINK_FLAGS "${COMMON_FLAGS} -s EXPORT_NAME='createCppApp'")
endif()

add_executable(TestApp test.cpp)
if(EMSCRIPTEN)
    set_target_properties(TestApp PROPERTIES LINK_FLAGS "${COMMON_FLAGS} -s EXPORT_NAME='createTestApp'")
endif()
