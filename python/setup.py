from pathlib import Path
from setuptools import find_packages, setup

this_directory = Path(__file__).parent
readme_path = this_directory / "README.md"
license_path = this_directory / "LICENSE"
long_description = readme_path.read_text(encoding="utf-8")

setup_kwargs = dict(
    name="m2m-sentinel",
    version="1.2.4",
    packages=find_packages(),
    description="Python client for M2M Sentinel Base bytecode capability, proxy and market observations",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="M2M Sentinel",
    author_email="contact@m2msentinel.com",
    url="https://m2msentinel.com",
    project_urls={
        "Documentation": "https://m2msentinel.com/docs.html",
        "OpenAPI": "https://api.m2msentinel.com/openapi.json",
        "Source": "https://github.com/M2M-Sentinel/m2m-sentinel-sdk",
    },
    python_requires=">=3.8",
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: Security",
    ],
)

# The clean exporter places the generated repository README and LICENSE beside
# this setup.py.  Keep source-tree builds useful when that generated LICENSE is
# not present, while making every exported PyPI artifact carry the exact copy.
if license_path.is_file():
    setup_kwargs["license_files"] = [license_path.name]

setup(**setup_kwargs)
