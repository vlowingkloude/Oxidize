add_library(lsp)

target_sources(
        lsp
        PUBLIC
        FILE_SET CXX_MODULES
        FILES
        ${CMAKE_CURRENT_SOURCE_DIR}/lsp.cppm
)

target_link_libraries(
        lsp
        PUBLIC
        json
        files
        boost_wrapper
)
