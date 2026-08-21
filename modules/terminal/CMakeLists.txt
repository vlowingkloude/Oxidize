add_library(terminal)

target_sources(
        terminal
        PUBLIC
        FILE_SET CXX_MODULES
        FILES
        ${CMAKE_CURRENT_SOURCE_DIR}/terminal.cppm
)

target_link_libraries(
        terminal
        PUBLIC
        json
        files
        boost_wrapper
)
