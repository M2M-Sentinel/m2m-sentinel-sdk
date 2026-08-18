from pathlib import Path
from setuptools import find_packages, setup

this_directory = Path(__file__).parent
long_description = (this_directory / "README.md").read_text(encoding="utf-8")

setup(
    name="m2m-sentinel",
    version="1.1.0",
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

