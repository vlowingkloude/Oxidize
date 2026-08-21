add_library(watcher)

target_sources(
        watcher
        PUBLIC
        FILE_SET CXX_MODULES
        FILES
        ${CMAKE_CURRENT_SOURCE_DIR}/watcher.cppm
)

target_link_libraries(
        watcher
        PUBLIC
        json
        files
        boost_wrapper
)
