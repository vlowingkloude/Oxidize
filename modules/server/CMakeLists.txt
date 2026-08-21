add_library(server)

target_sources(
        server
        PUBLIC
        FILE_SET CXX_MODULES
        FILES
        ${CMAKE_CURRENT_SOURCE_DIR}/server.cppm
)

find_package(Threads REQUIRED)

target_link_libraries(
        server
        PUBLIC
        json
        files
        lsp
        watcher
        terminal
        boost_wrapper
        Threads::Threads
)
