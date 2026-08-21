cmake_minimum_required(VERSION 4.2)

project(Oxidize LANGUAGES CXX)

option(OXIDIZE_TEST "Build Oxidize tests instead of the application" OFF)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPERIMENTAL_CXX_MODULE_CMAKE_API ON)
set(OXIDIZE_FRONTEND_DIST_DIRECTORY "${CMAKE_BINARY_DIR}/frontend/dist")

add_subdirectory(modules/json)
add_subdirectory(modules/boost)

add_subdirectory(modules/files)
add_subdirectory(modules/watcher)
add_subdirectory(modules/terminal)
add_subdirectory(modules/lsp)
add_subdirectory(modules/server)

if(OXIDIZE_TEST)
    enable_testing()
    add_subdirectory(tests)
else()
    add_subdirectory(main)

    find_program(COREPACK_EXECUTABLE corepack)
    if(COREPACK_EXECUTABLE)
        set(OXIDIZE_NPM_COMMAND "${COREPACK_EXECUTABLE}" npm)
    else()
        find_program(NPM_EXECUTABLE npm REQUIRED)
        set(OXIDIZE_NPM_COMMAND "${NPM_EXECUTABLE}")
    endif()

    file(GLOB_RECURSE OXIDIZE_FRONTEND_SOURCES CONFIGURE_DEPENDS frontend/src/*)

    add_custom_command(
            OUTPUT "${OXIDIZE_FRONTEND_DIST_DIRECTORY}/index.html"
            COMMAND ${OXIDIZE_NPM_COMMAND} ci
            COMMAND ${OXIDIZE_NPM_COMMAND} run build -- --outDir "${OXIDIZE_FRONTEND_DIST_DIRECTORY}" --emptyOutDir
            WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/frontend"
            DEPENDS
            frontend/index.html
            frontend/package.json
            frontend/package-lock.json
            frontend/tsconfig.json
            frontend/vite.config.ts
            ${OXIDIZE_FRONTEND_SOURCES}
            COMMENT "Building the Oxidize frontend"
            VERBATIM
    )

    add_custom_target(
            oxidize_frontend
            ALL
            DEPENDS "${OXIDIZE_FRONTEND_DIST_DIRECTORY}/index.html"
    )

    add_dependencies(oxidize oxidize_frontend)
endif()
