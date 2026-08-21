add_library(files)

target_sources(
        files
        PUBLIC
        FILE_SET CXX_MODULES
        FILES
        ${CMAKE_CURRENT_SOURCE_DIR}/files.cppm
)

target_link_libraries(
        files
        PUBLIC
        json
)